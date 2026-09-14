import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("reconcile_workspace_dns.py")
SPEC = importlib.util.spec_from_file_location("reconcile_workspace_dns", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def metadata(namespace, environment="dev", course_id="1"):
    return {
        "data": {
            "course-id": course_id,
            "namespace": namespace,
            "environment": environment,
        }
    }


def binding(namespace="dev"):
    return {
        "roleRef": {"kind": "ClusterRole", "name": "jcode-workspace-runtime-v2"},
        "subjects": [
            {
                "kind": "ServiceAccount",
                "namespace": namespace,
                "name": "jcode-workspace-v2",
            }
        ],
    }


class FakeKubectl:
    def __init__(self):
        self.updated = []
        self.deleted = []
        self.resources = {
            ("configmap", "jcode-generator-dev-configmap", "dev"): {
                "data": {
                    "WORKSPACE_DNS_CIDRS": "169.254.25.10/32,10.96.0.10/32",
                    "WATCHER_NAMESPACE": "dev",
                    "WORKSPACE_PROXY_NAMESPACE": "dev",
                    "WORKSPACE_PROXY_POD_LABEL": "jcode-router",
                    "WORKSPACE_PROXY_PORT": "3000",
                }
            },
            ("configmap", "jcode-course-metadata", "jcode-dev-active-1"): metadata(
                "jcode-dev-active-1"
            ),
            ("rolebinding", "jcode-workspace-runtime-v2", "jcode-dev-active-1"): binding(),
            ("configmap", "jcode-course-metadata", "jcode-dev-prod-1"): metadata(
                "jcode-dev-prod-1", environment="prod"
            ),
            ("rolebinding", "jcode-workspace-runtime-v2", "jcode-dev-prod-1"): binding(),
            ("configmap", "jcode-course-metadata", "jcode-dev-legacy-1"): metadata(
                "jcode-dev-legacy-1"
            ),
        }

    def get_json(self, resource, name=None, *, namespace=None, optional=False):
        if resource == "namespaces":
            return {
                "items": [
                    {"metadata": {"name": "jcode-dev-active-1"}},
                    {"metadata": {"name": "jcode-dev-prod-1"}},
                    {"metadata": {"name": "jcode-dev-legacy-1"}},
                    {"metadata": {"name": "jcode-dev-no-metadata-1"}},
                    {"metadata": {"name": "jcode-unmanaged-1"}},
                ]
            }
        if resource == "deployments":
            return {"items": []}
        value = self.resources.get((resource, name, namespace))
        if value is None and not optional:
            raise AssertionError(f"missing fixture: {resource}/{name} in {namespace}")
        return value

    def upsert_network_policy(self, namespace, policy):
        self.updated.append((namespace, policy))

    def delete_network_policy(self, namespace, name):
        self.deleted.append((namespace, name))


class ReconcileWorkspaceDnsTest(unittest.TestCase):
    def test_only_matching_v2_namespace_is_updated(self):
        kubectl = FakeKubectl()
        target = MODULE.parse_target("dev", None, None)

        updated = MODULE.reconcile(kubectl, target)

        self.assertEqual(updated, ["jcode-dev-active-1"])
        self.assertEqual(len(kubectl.updated), 5)
        namespace, legacy = kubectl.updated[0]
        self.assertEqual(legacy["metadata"]["name"], "legacy-workspace-egress")
        self.assertEqual(
            legacy["spec"]["podSelector"]["matchExpressions"][0],
            {"key": "jcode/session-kind", "operator": "DoesNotExist"},
        )
        namespace, default_deny = kubectl.updated[1]
        self.assertEqual(namespace, "jcode-dev-active-1")
        self.assertEqual(default_deny["metadata"]["name"], "workspace-default-deny-egress")
        self.assertEqual(default_deny["spec"]["egress"], [])
        policy = kubectl.updated[2][1]
        self.assertEqual(
            policy["spec"]["podSelector"]["matchLabels"],
            {"jcode/component": "workspace", "jcode/session-kind": "standard"},
        )
        peers = policy["spec"]["egress"][0]["to"]
        self.assertEqual(
            [peer["ipBlock"]["cidr"] for peer in peers if "ipBlock" in peer],
            ["169.254.25.10/32", "10.96.0.10/32"],
        )
        self.assertEqual(policy["spec"]["egress"][1]["ports"], [{"port": 3000, "protocol": "TCP"}])
        self.assertEqual(
            [item[1]["metadata"]["name"] for item in kubectl.updated[3:]],
            ["inspector-deny-egress", "snapshot-deny-egress"],
        )
        self.assertTrue(all(item[1]["spec"]["egress"] == [] for item in kubectl.updated[3:]))

    def test_invalid_dns_cidr_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "WORKSPACE_DNS_CIDRS"):
            MODULE.parse_dns_cidrs("169.254.25.10")

    def test_reconcile_preserves_restricted_workspace_egress(self):
        kubectl = FakeKubectl()
        kubectl.resources[("networkpolicy", "workspace-egress", "jcode-dev-active-1")] = {
            "spec": {
                "egress": [
                    {
                        "to": [{"ipBlock": {"cidr": "10.96.0.10/32"}}],
                        "ports": [{"port": 53, "protocol": "UDP"}],
                    }
                ]
            }
        }

        MODULE.reconcile(kubectl, MODULE.parse_target("dev", None, None))

        workspace_egress = kubectl.updated[2][1]
        self.assertEqual(len(workspace_egress["spec"]["egress"]), 1)
        self.assertEqual(
            workspace_egress["spec"]["egress"][0]["ports"],
            [{"port": 53, "protocol": "UDP"}, {"port": 53, "protocol": "TCP"}],
        )

    def test_finalize_refuses_to_remove_legacy_allow_while_workload_remains(self):
        kubectl = FakeKubectl()
        original = kubectl.get_json

        def get_json(resource, name=None, *, namespace=None, optional=False):
            if resource == "deployments":
                return {
                    "items": [{
                        "metadata": {"name": "jcode-old"},
                        "spec": {"template": {"metadata": {"labels": {"jcode/component": "workspace"}}}},
                    }]
                }
            return original(resource, name, namespace=namespace, optional=optional)

        kubectl.get_json = get_json
        with self.assertRaisesRegex(RuntimeError, "jcode-old"):
            MODULE.reconcile(kubectl, MODULE.parse_target("dev", None, None), finalize_legacy=True)
        self.assertEqual(kubectl.deleted, [])

    def test_finalize_removes_legacy_allow_after_all_workloads_are_labeled(self):
        kubectl = FakeKubectl()
        MODULE.reconcile(kubectl, MODULE.parse_target("dev", None, None), finalize_legacy=True)
        self.assertEqual(
            kubectl.deleted,
            [("jcode-dev-active-1", "legacy-workspace-egress")],
        )


if __name__ == "__main__":
    unittest.main()
