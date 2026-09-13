# syntax=docker/dockerfile:1-labs
# ---------------------------------------------
# Overleaf Community Edition (overleaf/overleaf)
# ---------------------------------------------

ARG OVERLEAF_BASE_TAG=sharelatex/sharelatex-base:latest
FROM $OVERLEAF_BASE_TAG

# Extra TeX Live on top of the base image's scheme-basic. Kept as the first
# layer so that a source change never invalidates a multi-gigabyte download,
# and empty by default so the stock build is unchanged. The base image turned
# off doc and source files, so a full scheme stays around 5 GB.
ARG TEXLIVE_SCHEME=
# The rolling tlnet mirrors now serve TeX Live 2026 while the base image has
# 2025 installed, and every package checksum then mismatches. Point at the
# frozen 2025 tree instead, which also makes the layer reproducible.
ARG TEXLIVE_MIRROR=https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2025/tlnet-final
# `fmtutil` runs with --strict in tlmgr's post actions, and one Polish format
# (utf8mex) does not build here, which would abort an otherwise complete
# install. Disable that format and finish the install.
RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -e' \
      '[ -n "$TEXLIVE_SCHEME" ] || exit 0' \
      'tlmgr option repository "$TEXLIVE_MIRROR" >/dev/null' \
      'tlmgr install "$@" || { fmtutil-sys --disablefmt utf8mex || true; tlmgr install "$@"; }' \
      'tlmgr path add >/dev/null' \
      'rm -rf /usr/local/texlive/*/tlpkg/backups' \
      > /usr/local/bin/tl-install \
 && chmod +x /usr/local/bin/tl-install

# Installed in groups rather than one `scheme-full` step, so that the result is
# a handful of moderate layers instead of a single multi-gigabyte blob. A host
# on a slow or lossy link retries one group at a time, and an image rebuild that
# only changes application code re-downloads none of them.
RUN tl-install scheme-small
RUN tl-install collection-latexrecommended collection-fontsrecommended
RUN tl-install collection-latexextra
RUN tl-install collection-fontsextra
RUN tl-install collection-mathscience collection-bibtexextra collection-pictures
RUN tl-install collection-langeuropean collection-langcjk collection-langother
RUN if [ -n "$TEXLIVE_SCHEME" ]; then \
      tl-install "$TEXLIVE_SCHEME" \
      &&  kpsewhich xkeyval.sty \
      &&  kpsewhich acmart.cls \
      &&  kpsewhich IEEEtran.cls ; \
    fi

WORKDIR /overleaf

# Add required source files for yarn install
# -------------------------------------------
COPY --parents libraries/*/package.json .yarn/patches/ services/*/package.json tools/migrations/ package.json yarn.lock .yarnrc.yml /overleaf/
COPY server-ce/genScript.js server-ce/services.js /overleaf/

# Pre-install yarn via corepack so it is available at runtime for all users
# -------------------------------------------------------------------------
# Corepack setup, shared between all the images.
ENV PATH="/overleaf/node_modules/.bin:$PATH"
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack install -g yarn@4.14.1
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
    --mount=type=cache,target=/overleaf/services/web/node_modules/.cache,id=server-ce-webpack-cache \
    --mount=type=tmpfs,target=/tmp \
    node genScript compile | bash

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

# Phusion Image timeouts before sending SIGKILL to processes
# ----------------------------------------------------------
ENV KILL_PROCESS_TIMEOUT=55
ENV KILL_ALL_PROCESSES_TIMEOUT=55
ENV GRACEFUL_SHUTDOWN_DELAY_SECONDS=1

ENV NODE_ENV="production"
ENV LOG_LEVEL="info"


EXPOSE 80

ENTRYPOINT ["/sbin/my_init"]
