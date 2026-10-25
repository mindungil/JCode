# JCode 모니터링 (Grafana, 추가 수집 대상)

kube-prometheus-stack(helm release `prometheus`, namespace `monitoring`)은 이 디렉터리 밖에서 설치되어 있습니다.
여기에는 그 위에 얹는 것만 있습니다.

- `prometheus/`: 추가 수집 대상. Longhorn ServiceMonitor, `watcher-postgres` PodMonitor, ingress-nginx 메트릭 Service·ServiceMonitor, MariaDB exporter
- `grafana/`: Grafana Deployment·PVC·Service·Ingress와 provisioning(데이터소스, 대시보드 목록)
- `dashboards/`: 대시보드 JSON. Grafana가 `JCode` 폴더로 읽습니다. `jcode-overview`(홈), `jcode-ide`(학생 IDE), `jcode-storage`(저장소), `jcode-db`(DB), `jcode-cluster`(클러스터)

Grafana 주소는 `https://jcode.jedutools.io/grafana/`입니다. ingress는 `/grafana` 경로만 추가하고 기존 JCode 경로는 건드리지 않습니다.
데이터소스는 클러스터 안 주소 `http://prometheus-operated.monitoring.svc:9090`을 쓰므로 Prometheus 외부 ingress의 basic auth와 무관합니다.

## 처음 적용

관리자 계정 Secret과 MariaDB exporter 접속 Secret을 먼저 만듭니다. 비밀번호는 저장소에 넣지 않습니다.
MariaDB에는 읽기 전용 계정 `'exporter'@'10.0.0.%'`(PROCESS, BINLOG MONITOR, SLAVE MONITOR, `performance_schema` SELECT, 최대 연결 3)이 있어야 합니다.

```bash
kubectl -n monitoring create secret generic grafana-admin \
  --from-literal=admin-user=admin \
  --from-literal=admin-password="$(openssl rand -base64 24)"
kubectl -n monitoring create secret generic mariadb-exporter --from-file=.my.cnf=<user·password·host=10.0.0.234가 든 my.cnf>
kubectl apply -k deploy/monitoring
```

ingress-nginx 메트릭은 DaemonSet 인자 `--enable-metrics=true`와 컨테이너 포트 `metrics`(10254)가 있어야 수집됩니다.
DaemonSet은 이 디렉터리에서 관리하지 않으므로 바꿀 때 따로 확인합니다. 인자를 바꾸면 ingress 파드가 하나씩 재시작됩니다.

## 대시보드 고치기

1. Grafana 화면에서 고칩니다 (`allowUiUpdates: true`).
2. 대시보드 설정 → JSON Model을 복사해 `dashboards/`의 같은 파일에 덮어씁니다.
3. `kubectl apply -k deploy/monitoring`로 다시 적용합니다. 저장소에 넣지 않은 화면 수정은 Grafana 재시작 후 파일 내용으로 돌아갈 수 있습니다.

새 대시보드는 `dashboards/`에 JSON을 추가하고 `kustomization.yaml`의 `grafana-dashboards` 목록에 넣습니다.

## 이 디렉터리 밖에서 함께 바꾼 것 (2026-10-25)

- kube-prometheus-stack helm 값: Prometheus 저장소 PVC 20Gi(`longhorn-r2-retain`), `retentionSize: 15GB`, requests 500m/2560Mi, memory limit 4Gi
- 옛 kubelet Service 2개(`kube-system/kubelet`, `kube-system/kube-prometheus-stack-kubelet`) 삭제. operator가 쓰는 것은 `prometheus-kube-prometheus-kubelet`

- kube-prometheus-stack helm 값: `kube-state-metrics.metricAnnotationsAllowList`에 `namespaces=[jcode.io/display-name,jcode.io/course-name,jcode.io/course-id]` → 강의명 표시
- `deploy/production-state/configmaps.yaml`의 `jcode-backend-config`: backend `http.server.requests` histogram(5ms~10s) → p95
- router: `jcode_router_websocket_connections`, `jcode_router_websocket_users` (브랜치 `feat/router-socket-metrics`)

## 아직 없는 것

- Keycloak 로그인: `key.jedutools.io` realm `JEduTools`의 `grafana` 클라이언트가 비활성 상태라 지금은 관리자 계정만 씁니다
- 알림(Alertmanager)
