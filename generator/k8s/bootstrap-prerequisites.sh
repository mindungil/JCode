#!/usr/bin/env bash
set -euo pipefail

external_secrets_version=${EXTERNAL_SECRETS_VERSION:-2.9.0}
watcher_namespace=watcher

for command in kubectl helm python3; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 2; }
done

kubectl create namespace "$watcher_namespace" --dry-run=client -o yaml | kubectl apply -f -
helm repo add external-secrets https://charts.external-secrets.io --force-update
helm repo update external-secrets
helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace \
  --version "$external_secrets_version" \
  --set installCRDs=true \
  --wait \
  --timeout 10m

kubectl wait --for=condition=Established crd/externalsecrets.external-secrets.io --timeout=2m
kubectl wait --for=condition=Established crd/clustersecretstores.external-secrets.io --timeout=2m
kubectl get secret watcher-harbor-registry-secret -n "$watcher_namespace" >/dev/null
kubectl apply -f generator/k8s/harbor-external-secret-store.yaml
kubectl wait --for=condition=Ready clustersecretstore/jcode-harbor-pull-secret --timeout=2m

ROUTER_NAMESPACE="$watcher_namespace" \
  ALLOWED_NETWORK_CIDR="${ALLOWED_NETWORK_CIDR:?ALLOWED_NETWORK_CIDR is required}" \
  HTTP_PORT="${HTTP_PORT:-3000}" \
  router/k8s/configure-squid.sh
