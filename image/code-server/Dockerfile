ARG JCODE_CODE_SERVER_BASE
ARG JCODE_CODE_SERVER_RUNTIME_BASE=${JCODE_CODE_SERVER_BASE}
FROM ${JCODE_CODE_SERVER_BASE} AS code-server-base-metadata
FROM ${JCODE_CODE_SERVER_RUNTIME_BASE}
ARG JCODE_CODE_SERVER_BASE_DIGEST
ARG JCODE_CODE_SERVER_REVISION

LABEL org.opencontainers.image.title="JCode IDE"
LABEL org.opencontainers.image.description="JCode - 전북대학교 웹 IDE 플랫폼"
LABEL org.opencontainers.image.authors="OSLAB"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/mindungil/JCode-CodeServer"
LABEL org.opencontainers.image.revision="${JCODE_CODE_SERVER_REVISION}"
LABEL org.opencontainers.image.base.digest="${JCODE_CODE_SERVER_BASE_DIGEST}"

USER root
ENV DEBIAN_FRONTEND=noninteractive

# 필요한 패키지 설치: gcc, python3, python3-pip
RUN if ! command -v gcc >/dev/null || ! command -v gdb >/dev/null || ! command -v python3 >/dev/null; then \
      apt-get update && apt-get install --no-install-recommends -y \
        gcc \
        gdb \
        build-essential \
        libc6-dev \
        python3 \
        python3-pip && \
      rm -rf /var/lib/apt/lists/*; \
    fi

# ===== JCode UI 커스터마이징 =====

# 1. 기반 이미지의 commit/version/확장 메타데이터를 보존하면서 브랜딩만 병합
COPY customization/product.json /tmp/jcode-product-overrides.json
COPY --from=code-server-base-metadata /usr/lib/code-server/lib/vscode/product.json /tmp/code-server-base-product.json
RUN node -e 'const fs=require("fs"); const path="/usr/lib/code-server/lib/vscode/product.json"; const product=JSON.parse(fs.readFileSync("/tmp/code-server-base-product.json")); const overrides=JSON.parse(fs.readFileSync("/tmp/jcode-product-overrides.json")); fs.writeFileSync(path, JSON.stringify({...product,...overrides}, null, 2)+"\n"); const merged=JSON.parse(fs.readFileSync(path)); for (const bundle of ["/usr/lib/code-server/lib/vscode/out/server-main.js", "/usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js"]) { if (!fs.readFileSync(bundle, "utf8").includes(merged.commit)) throw new Error(`product commit ${merged.commit} does not match ${bundle}`); }' && \
    rm /tmp/jcode-product-overrides.json /tmp/code-server-base-product.json

# 2. workbench.html 교체 (커스텀 CSS 주입 포인트)
COPY customization/workbench.html /usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.html

# 3. 커스텀 CSS (Dracula 테마, 불필요한 UI 숨김)
COPY customization/jcode.css /usr/lib/code-server/src/browser/media/jcode.css

# 4. 워크스페이스 제한 쉘 스크립트
COPY restricted-shell.sh /etc/profile.d/restricted-shell.sh
RUN chmod 644 /etc/profile.d/restricted-shell.sh

# 파일 권한 설정
RUN chown -R 1000:1000 /usr/lib/code-server/lib/vscode/product.json \
    /usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.html \
    /usr/lib/code-server/src/browser/media/jcode.css

EXPOSE 8080

# 기본 사용자 설정 (settings.json)
USER coder
RUN mkdir -p /home/coder/.local/share/code-server/User
COPY customization/settings.json /home/coder/.local/share/code-server/User/settings.json

# code-server 실행
CMD ["code-server", "--bind-addr", "0.0.0.0:8080", "--auth", "none", "--app-name", "JCode IDE", "--welcome-text", "JCode IDE에 오신 것을 환영합니다.", "--disable-getting-started-override", "--disable-workspace-trust"]
