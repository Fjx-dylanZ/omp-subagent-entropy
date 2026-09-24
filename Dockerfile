# syntax=docker/dockerfile:1.26.0@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

# Isolated, reproducible dev/test/release images for omp-subagent-entropy (linux/arm64 only).
#
#   docker compose build dev
#   docker compose run --rm dev                      # bun run check (offline)
#   docker compose run --rm dev omp --version        # ad-hoc omp / bun / bash
#
# Clean package-install smoke (packed tarball -> real `omp plugin install` -> installed discovery), offline;
# run it with the same isolation flags as .github/workflows/ci.yml:
#   docker build --platform linux/arm64 --target install-smoke -t omp-subagent-entropy-install .
#
# Release tarball + SHA256SUMS into ./dist (export-only):
#   docker buildx build --platform linux/arm64 --target package --output type=local,dest=dist .
#
# Apply the formatter; exports ONLY the formatter's inputs back into the checkout:
#   docker buildx build --platform linux/arm64 --target formatted --output type=local,dest=. .
#
# Generate or refresh bun.lock inside Docker (writes ./bun.lock and nothing else):
#   docker buildx build --platform linux/arm64 --target lockfile --output type=local,dest=. .

# ---------------------------------------------------------------------------
# base: pinned Bun runtime (multi-arch index digest; arm64 is enforced below).
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS base
ARG TARGETARCH
USER root
# The checksum-pinned omp release binary is the linux-arm64 asset.
RUN test "${TARGETARCH}" = "arm64" \
    || { echo "omp-subagent-entropy dev image supports linux/arm64 only (TARGETARCH=${TARGETARCH})" >&2; exit 1; }
WORKDIR /work

# ---------------------------------------------------------------------------
# lockfile: resolve the full dependency graph from package.json (+ existing
# bun.lock when present, so refreshes stay minimal). Export-only target.
# ---------------------------------------------------------------------------
FROM base AS lock-resolve
COPY package.json bun.loc[k] ./
RUN bun install --lockfile-only --ignore-scripts

FROM scratch AS lockfile
COPY --from=lock-resolve /work/bun.lock /bun.lock

# ---------------------------------------------------------------------------
# deps: frozen, script-free Linux install. The npm host package supplies types
# only (the runtime is the pinned release binary), so optional heavy native
# deps (onnx/transformers/sherpa, pi-natives platform leaves) are omitted.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json bun.lock ./
# node_modules/.bin/omp (the npm package's JS CLI) would shadow
# /usr/local/bin/omp inside `bun run` scripts and cannot run without the
# omitted natives; drop it so `omp` always means the pinned release binary.
RUN bun install --frozen-lockfile --ignore-scripts --omit=optional \
    && rm -f node_modules/.bin/omp

# ---------------------------------------------------------------------------
# pack: the release tarball exactly as `bun pm pack` publishes it. The input is
# the whole default-deny build context, so package.json "files" alone decides
# what ships. No dependencies, lifecycle scripts, or network.
# ---------------------------------------------------------------------------
FROM base AS pack
COPY . .
RUN bun pm pack --ignore-scripts --quiet --destination /pack \
    && cd /pack \
    && sha256sum -- *.tgz > SHA256SUMS

FROM scratch AS package
COPY --from=pack /pack/ /

# ---------------------------------------------------------------------------
# omp: checksum-verified omp 18.3.0 + nonroot user + container-local state.
# Shared runtime of the dev and install-smoke images.
# ---------------------------------------------------------------------------
FROM base AS omp
ADD --checksum=sha256:bdfb9c494e17a2fee1956dae16a010a1953574ce4172c4db8efe06fbe477c637 --chmod=0755 \
    https://github.com/can1357/oh-my-pi/releases/download/v18.3.0/omp-linux-arm64 /usr/local/bin/omp

# Dedicated nonroot user with an empty HOME (compose overlays tmpfs on HOME and
# XDG_RUNTIME_DIR). Smoke-test the binary under a throwaway HOME so no omp
# state (natives cache, install id, logs) lands in the image.
RUN groupadd --gid 10001 dev \
    && useradd --uid 10001 --gid 10001 --no-create-home --no-log-init \
        --home-dir /home/dev --shell /bin/bash dev \
    && install -d -o 10001 -g 10001 -m 0700 /home/dev /run/user/10001 \
    && check_home="$(mktemp -d)" \
    && HOME="${check_home}" OMP_SKIP_SETUP=1 OTEL_SDK_DISABLED=true omp --version \
    && rm -rf "${check_home}"

# Fresh, fully container-local omp/Bun state. OMP data paths honor XDG_* only
# when "$XDG_*/omp" already exists, so all omp state stays under ~/.omp.
ENV HOME=/home/dev \
    PI_CONFIG_DIR=.omp \
    PI_CODING_AGENT_DIR=/home/dev/.omp/agent \
    PI_CODING_AGENT_SESSION_DIR=/home/dev/.omp/agent/sessions \
    XDG_CONFIG_HOME=/home/dev/.config \
    XDG_CACHE_HOME=/home/dev/.cache \
    XDG_DATA_HOME=/home/dev/.local/share \
    XDG_STATE_HOME=/home/dev/.local/state \
    XDG_RUNTIME_DIR=/run/user/10001 \
    TMPDIR=/tmp \
    OMP_SKIP_SETUP=1 \
    OTEL_SDK_DISABLED=true

# ---------------------------------------------------------------------------
# install-smoke: clean consumer image. Only Bun, pinned omp, the packed
# artifact, and the two test runners: no package.json, src/, or node_modules,
# so the extension can only come from `omp plugin install`. Offline at runtime.
# ---------------------------------------------------------------------------
FROM omp AS install-smoke
COPY --from=pack --chmod=u=rwX,go=rX /pack/ /opt/package/
COPY --chmod=u=rwX,go=rX tests/install.ts tests/runtime.ts ./tests/
USER 10001:10001
ENTRYPOINT []
CMD ["bun", "--no-install", "tests/install.ts"]

# ---------------------------------------------------------------------------
# dev: omp + frozen deps + read-only project sources, nonroot.
# ---------------------------------------------------------------------------
FROM omp AS dev
# Sources stay root-owned and read-only for the runtime user; everything
# writable lives in HOME, TMPDIR, and XDG_RUNTIME_DIR.
COPY --from=deps /work/node_modules ./node_modules
COPY --chmod=u=rwX,go=rX package.json bun.lock tsconfig.json .prettierrc.json ./
COPY --chmod=u=rwX,go=rX src ./src
COPY --chmod=u=rwX,go=rX tests ./tests
COPY --chmod=u=rwX,go=rX .github/workflows/ci.yml ./.github/workflows/ci.yml
USER 10001:10001
ENTRYPOINT []
CMD ["bun", "run", "check"]

# ---------------------------------------------------------------------------
# formatted: `bun run format` over the dev tree; export-only, never mounts the
# checkout. Emits exactly the formatter's inputs, nothing else.
# ---------------------------------------------------------------------------
FROM dev AS format-run
USER root
RUN bun run format

FROM scratch AS formatted
COPY --from=format-run /work/src /src
COPY --from=format-run /work/tests /tests
COPY --from=format-run /work/package.json /work/tsconfig.json /work/.prettierrc.json /
COPY --from=format-run /work/.github/workflows/ci.yml /.github/workflows/ci.yml
