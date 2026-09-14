# Workspace proxy policy

`squid_example.conf` is the template rendered by `../k8s/configure-squid.sh`.
Keep both destination and TLS-server-name lists in sync when updating providers.
The policy is for JCode workspace traffic, not Bastion/node administration.

## Controls

- Normal HTTP/HTTPS package downloads and Git over HTTPS remain available.
- Known OpenAI/Codex, Claude, Gemini, Grok, Copilot, OpenRouter and DeepSeek
  endpoints are blocked, including listed regional cloud inference endpoints.
- Numeric destinations and private networks are denied by the proxy.
- CONNECT is restricted to port 443. SSH endpoints on 443 are also denied.
- TLS ClientHello inspection rejects a blocked SNI and does not forward raw SSH
  as a CONNECT tunnel. Allowed TLS is spliced without decrypting HTTPS payloads.
- The workspace NetworkPolicy must force egress through this proxy. A proxy
  environment variable on its own is not an enforcement boundary.

An installed CLI can still display help. The control blocks its known remote
inference endpoints, not every executable with an AI-related name. Unlisted
relays, encrypted SSH inside an otherwise permitted TLS connection, local models,
and activity on a student's own device are not universally prevented.

## TLS context and deployment

Squid requires a TLS context for peek/splice. The configuration script creates
`jcode-squid-peek-tls` only when absent; the base Router manifest mounts it.
This self-signed certificate has CA:FALSE. Do not install it in client trust
stores. It is unrelated to HAProxy/domain certificates. Retain the Secret across
deployments, rotate before its ten-year expiration, and roll the Router after
rotation. Missing or invalid TLS initialization must not be ignored: check the
Squid log for `Accepting SSL bumped HTTP Socket` and run a blocked-SNI probe.

Denied AI CONNECTs terminate before peek, rather than using Squid's TLS error-page
generation. Plain HTTP requests to blocked providers return 403. Known HTTPS AI
requests normally fail with an aborted CONNECT, not an upstream API response.

For an existing installation, render/apply the ConfigMap using the configuration
script, ensure the base Router TLS Secret mount is present, and roll the Router.
The squid.conf mount uses subPath, so ConfigMap edits alone do not reload it.
Restarting only the Squid process inside an existing Pod retains its old subPath
mount; recreate the Pod through a Deployment rollout instead.

Reconcile existing course namespace policies with Generator's current rules:
standard workspaces receive DNS and package-proxy egress; inspector/snapshot
workspaces receive no egress. Ingress to workspace Pods is only from Router Pods
on IDE/VNC ports. Remove old broad allow rules; deny policies are additive and
cannot override those allow rules.

After rollout, check both Router replicas, each worker's normal/blocked egress,
extension downloads, Git HTTPS, and authenticated IDE/VNC routing. SSH Git URLs
must be replaced with HTTPS URLs. Never remove the Bastion or host SSH rules to
implement a workspace restriction.
