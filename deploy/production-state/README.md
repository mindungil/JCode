# Production state

This directory records the non-secret Kubernetes state required to recreate the
JCode V2 runtime in the `watcher` namespace. It is intentionally separate from
the controller overlay so updating a controller does not silently replace shared
storage or application configuration.

## Required secrets

Create these Secrets through the cluster secret manager before applying this
directory. Never commit their values.

- `jcode-backend-secret`: Backend database, JWT, Redis and Generator credentials
- `jcode-generator-secret`: Generator service token verification key
- `jcode-router-secret`: Router JWT keys and `REDIS_PASSWORD`
- `jcode-redis-secret`: `REDIS_PASSWORD`
- `watcher-harbor-registry-secret`: Harbor pull credentials

`jcode-redis-secret/REDIS_PASSWORD` and the Backend/Router Redis password must
contain the same value.

## Restore order

1. Restore Longhorn volumes and bind the retained PVs to the PVC names in
   `storage.yaml`. Applying an empty PVC does not restore its data.
   The `longhorn-worker1-r1` class also requires a Longhorn disk tagged
   `worker1-storage`.
2. Apply the non-secret state:

   ```bash
   kubectl apply -k deploy/production-state
   ```

3. Refresh the dynamic Longhorn RWX share-manager addresses:

   ```bash
   JCODE_NAMESPACE=watcher \
   GENERATOR_CONFIGMAP_NAME=jcode-generator-configmap \
     generator/k8s/configure-workspace-storage.sh
   ```

4. Deploy the immutable image digests recorded in
   `deploy/releases/production-current.json`, then restart Backend, Frontend,
   Generator, Bootstrap and Router so ConfigMap values are reloaded.

The NFS server addresses in `configmaps.yaml` document the captured live state.
The refresh command is mandatory after a volume or share-manager recreation.
CloudNativePG must be installed before applying `watcher-postgres.yaml`. On a
fresh cluster, restore the Watcher database from backup instead of treating the
empty `initdb` database as recovered data.
