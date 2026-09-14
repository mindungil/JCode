#!/usr/bin/env bash
set -euo pipefail

namespace=${ROUTER_NAMESPACE:-watcher}
port=${HTTP_PORT:-3000}
allowed_cidr=${ALLOWED_NETWORK_CIDR:?ALLOWED_NETWORK_CIDR is required}

if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo "HTTP_PORT must be between 1 and 65535" >&2
  exit 2
fi
python3 - "$allowed_cidr" <<'PY'
import ipaddress
import sys

try:
    ipaddress.ip_network(sys.argv[1], strict=False)
except ValueError as error:
    raise SystemExit(f"ALLOWED_NETWORK_CIDR is invalid: {error}")
PY

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
config_file="$work_dir/squid.conf"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
sed -e "s|{{HTTP_PORT}}|${port}|g" \
    -e "s|{{ALLOWED_NETWORK_CIDR}}|${allowed_cidr}|g" \
    "$script_dir/../squid/squid_example.conf" > "$config_file"

# Squid requires a TLS context even for peek/splice. This is not a trusted CA:
# clients retain the real upstream certificate and HTTPS is never decrypted.
tls_secret=$(kubectl get secret jcode-squid-peek-tls --namespace "$namespace" --ignore-not-found -o name)
if [[ -z "$tls_secret" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$work_dir/tls.key" -out "$work_dir/tls.crt" -days 3650 \
    -subj '/CN=JCode TLS metadata inspection only' \
    -addext 'basicConstraints=critical,CA:FALSE'
  kubectl create secret tls jcode-squid-peek-tls --namespace "$namespace" \
    --cert="$work_dir/tls.crt" --key="$work_dir/tls.key" \
    --dry-run=client -o yaml | kubectl apply -f -
fi

for required_line in \
  "acl workspace_network src ${allowed_cidr}" \
  "acl cache_manager urlpath_regex -i ^/squid-internal-mgr/" \
  "http_access allow cache_manager workspace_network" \
  "http_access deny cache_manager" \
  "http_access deny blocked_ai !connect_method" \
  "ssl_bump terminate blocked_ai" \
  "http_access deny connect_method !tls_ports" \
  "ssl_bump peek tls_step1" \
  "on_unsupported_protocol respond all" \
  "http_access allow workspace_network" \
  "http_access deny all"; do
  grep -Fxq "$required_line" "$config_file" || {
    echo "generated squid.conf is missing: $required_line" >&2
    exit 2
  }
done

kubectl create configmap squid-config \
  --namespace "$namespace" \
  --from-file="squid.conf=${config_file}" \
  --dry-run=client -o yaml | kubectl apply -f -

applied_config=$(kubectl get configmap squid-config --namespace "$namespace" -o jsonpath='{.data.squid\.conf}')
for required_line in \
  "acl workspace_network src ${allowed_cidr}" \
  "acl cache_manager urlpath_regex -i ^/squid-internal-mgr/" \
  "http_access allow cache_manager workspace_network" \
  "http_access deny cache_manager" \
  "http_access deny blocked_ai !connect_method" \
  "ssl_bump terminate blocked_ai" \
  "http_access deny connect_method !tls_ports" \
  "ssl_bump peek tls_step1" \
  "on_unsupported_protocol respond all" \
  "http_access allow workspace_network" \
  "http_access deny all"; do
  grep -Fxq "$required_line" <<<"$applied_config" || {
    echo "applied squid.conf is missing: $required_line" >&2
    exit 2
  }
done
