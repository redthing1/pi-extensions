FROM node:22.23.1-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ARG OPENSSH_SERVER_VERSION=1:9.2p1-2+deb12u10
ARG RIPGREP_VERSION=13.0.0-4+b2
ARG FD_FIND_VERSION=8.6.0-3

RUN apt-get update \
	&& apt-get install --yes --no-install-recommends \
		"openssh-server=${OPENSSH_SERVER_VERSION}" \
		"ripgrep=${RIPGREP_VERSION}" \
		"fd-find=${FD_FIND_VERSION}" \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --create-home --uid 10001 --shell /bin/bash teleport \
	&& passwd --delete teleport \
	&& install -d -m 0755 /run/sshd \
	&& install -d -o teleport -g teleport -m 0700 /home/teleport/.ssh \
	&& install -d -o teleport -g teleport -m 0755 /workspace

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/teleport-test-entrypoint

RUN chmod 0755 /usr/local/bin/teleport-test-entrypoint

EXPOSE 2222

ENTRYPOINT ["/usr/local/bin/teleport-test-entrypoint"]
