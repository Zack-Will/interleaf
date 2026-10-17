# syntax=docker/dockerfile:1-labs
# ---------------------------------------------
# Overleaf Community Edition (overleaf/overleaf)
# ---------------------------------------------

ARG OVERLEAF_BASE_TAG=sharelatex/sharelatex-base:latest
FROM $OVERLEAF_BASE_TAG

# Interleaf: the base is ghcr.io/<owner>/interleaf-base, which adds the TeX
# Live collections to upstream's base (server-ce/Dockerfile-base-interleaf).
#
# The fork publishes the engine and its matching support files together.
# Keep them outside TEXMFLOCAL, which toolkit operators can mount over.
ARG RTEX_RELEASE=interleaf-0.0.3-2
ARG RTEX_SHA256=3e56e697c93dbc1cd3df39ad49b16d31dc3efa31438c3edcfefaa1dcf084e6c3
ENV RTEX_TEXDIR=/usr/local/share/rtex/tex
RUN curl --fail --location --retry 3 \
      "https://github.com/Zack-Will/realtime-tex/releases/download/${RTEX_RELEASE}/rtex-x86_64-unknown-linux-gnu.tar.gz" \
      --output /tmp/rtex.tar.gz \
 && echo "${RTEX_SHA256}  /tmp/rtex.tar.gz" | sha256sum --check --strict \
 && mkdir /tmp/rtex \
 && tar -xzf /tmp/rtex.tar.gz -C /tmp/rtex --strip-components=1 \
 && install -m 755 /tmp/rtex/bin/rtex /usr/local/bin/rtex \
 && mkdir -p /usr/local/share/rtex \
 && cp -R /tmp/rtex/share/rtex/tex /usr/local/share/rtex/tex \
 && install -D -m 644 /tmp/rtex/LICENSE /usr/local/share/doc/rtex/LICENSE \
 && chmod -R a+rX /usr/local/share/rtex \
 && rm -rf /tmp/rtex /tmp/rtex.tar.gz

WORKDIR /overleaf

# Add required source files for yarn install
# -------------------------------------------
COPY --parents libraries/*/package.json .yarn/patches/ services/*/package.json tools/migrations/ package.json yarn.lock .yarnrc.yml .pnp.register.mjs /overleaf/
COPY server-ce/genScript.js server-ce/services.js /overleaf/

# Pre-install yarn via corepack so it is available at runtime for all users
# -------------------------------------------------------------------------
# Corepack setup, shared between all the images.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack install -g yarn@4.18.0
ENV COREPACK_ENABLE_NETWORK=0

# Install yarn dependencies
# -------------------------
RUN --mount=type=cache,target=/root/.cache \
    --mount=type=cache,target=/root/.yarn/berry/cache,id=server-ce-yarn-cache \
    --mount=type=cache,target=/usr/local/share/.cache/yarn,id=server-ce-yarn-fallback-cache \
    --mount=type=tmpfs,target=/tmp node genScript install | bash

# Add the actual source files
# ---------------------------
COPY --parents libraries/ services/ tools/migrations/ /overleaf/
RUN --mount=type=cache,target=/root/.cache \
    --mount=type=cache,target=/root/.yarn/berry/cache,id=server-ce-yarn-cache \
    --mount=type=cache,target=/usr/local/share/.cache/yarn,id=server-ce-yarn-fallback-cache \
    --mount=type=cache,target=/overleaf/services/web/.cache,id=server-ce-webpack-cache \
    --mount=type=tmpfs,target=/tmp \
    node genScript compile | bash

# Enable Yarn PnP resolution for all Node.js processes
# -----------------------------------------------------
ENV NODE_OPTIONS="--require /overleaf/.pnp.cjs --import /overleaf/.pnp.register.mjs"

# Copy runit service startup scripts to its location
# --------------------------------------------------
ADD server-ce/runit /etc/service

# Copy runit global settings to its location
# ------------------------------------------
ADD server-ce/config/env.sh /etc/overleaf/env.sh

# Configure nginx
# ---------------
ADD server-ce/nginx/nginx.conf.template /etc/nginx/templates/nginx.conf.template
ADD server-ce/nginx/overleaf.conf /etc/nginx/sites-enabled/overleaf.conf
ADD server-ce/nginx/clsi-nginx.conf /etc/nginx/sites-enabled/clsi-nginx.conf


# Configure log rotation
# ----------------------
ADD server-ce/logrotate/overleaf /etc/logrotate.d/overleaf
RUN chmod 644 /etc/logrotate.d/overleaf

# Configure cron tasks
# ----------------------
ADD server-ce/cron /overleaf/cron
ADD server-ce/config/crontab-history /etc/cron.d/crontab-history
RUN chmod 600 /etc/cron.d/crontab-history
ADD server-ce/config/crontab-deletion /etc/cron.d/crontab-deletion
RUN chmod 600 /etc/cron.d/crontab-deletion

# Copy Phusion Image startup and shutdown scripts to their locations
# ------------------------------------------------------------------
COPY server-ce/init_scripts/ /etc/my_init.d/
COPY server-ce/init_preshutdown_scripts/ /etc/my_init.pre_shutdown.d/

# Copy app settings files
# -----------------------
COPY server-ce/config/settings.js /etc/overleaf/settings.js

# The licence of this distribution (AGPL-3.0) and the notice of what it bundles
COPY LICENSE NOTICE.md /overleaf/

# Copy history-v1 files
# -----------------------
COPY server-ce/config/production.json /overleaf/services/history-v1/config/production.json
COPY server-ce/config/custom-environment-variables.json /overleaf/services/history-v1/config/custom-environment-variables.json

# Copy grunt thin wrapper
# -----------------------
ADD server-ce/bin/grunt /usr/local/bin/grunt
RUN chmod +x /usr/local/bin/grunt

# Copy history helper scripts
# ---------------------------
ADD server-ce/bin/flush-history-queues /overleaf/bin/flush-history-queues
RUN chmod +x /overleaf/bin/flush-history-queues
ADD server-ce/bin/force-history-resyncs /overleaf/bin/force-history-resyncs
RUN chmod +x /overleaf/bin/force-history-resyncs

# Copy Latexmkrc
# -----------------------
COPY server-ce/config/latexmkrc /usr/local/share/latexmk/LatexMk

# File that controls open|closed status of the site
# -------------------------------------------------
ENV SITE_MAINTENANCE_FILE="/etc/overleaf/site_status"
RUN touch $SITE_MAINTENANCE_FILE

# Set Environment Variables
# --------------------------------
ENV OVERLEAF_CONFIG=/etc/overleaf/settings.js

ENV WEB_API_USER="overleaf"
ENV ADMIN_PRIVILEGE_AVAILABLE="true"

ENV OVERLEAF_APP_NAME="Overleaf Community Edition"

ENV OPTIMISE_PDF="true"

ENV REQ_VALIDATION_MODE=enforce-log

# Phusion Image timeouts before sending SIGKILL to processes
# ----------------------------------------------------------
ENV KILL_PROCESS_TIMEOUT=55
ENV KILL_ALL_PROCESSES_TIMEOUT=55
ENV GRACEFUL_SHUTDOWN_DELAY_SECONDS=1

ENV NODE_ENV="production"
ENV LOG_LEVEL="info"


EXPOSE 80

ENTRYPOINT ["/sbin/my_init"]
