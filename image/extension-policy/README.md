# Extension Installation Policy

General extensions can be installed directly from Open VSX or VSIX. AI-related
IDs, names, descriptions, keywords, categories and chat-provider declarations
are rejected by the server installer. Dependencies and profile imports are also
checked. The scanner excludes matching extensions already on disk.
Browser-only extension installation and scanning use the same filter. The
workbench script URL includes a policy revision to avoid stale browser assets.

This is a keyword filter, not a sandbox or a reliable classifier of arbitrary
code. Renamed or misleading manifests can evade it; terminal programs and
external AI services are outside this filter. Review false positives before
changing the shared rules. Do not treat the VS Code policy file alone as CLI
installation enforcement in code-server.

Build either image with the shared named context (from the repository root):

```sh
buildah bud --build-context jcode-extension-policy=./image/extension-policy \
  -t <registry>/code-server:<tag> ./image/code-server
buildah bud --build-context jcode-extension-policy=./image/extension-policy \
  -t <registry>/code-server-vnc:<tag> ./image/code-server-vnc
```

Docker Buildx supports the same named context. The upstream version and digest
are pinned in each Dockerfile. A changed bundle causes the patch to fail during
the build, requiring enforcement-point review before upgrading. Check both CLI
and browser installation, VSIX, dependencies, existing installed extensions,
normal Python/C++ language tooling and the VNC variant before deployment.

Inspector and snapshot sessions use an isolated read-only extension directory
with a pre-created empty `extensions.json` from a ConfigMap:
student-controlled extensions must not execute in a manager's inspection session.
