import importlib
import sys
from pathlib import Path

import pytest
from kubernetes import config

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def generator(monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "test-secret")
    monkeypatch.setenv("ALGORITHM", "HS256")
    monkeypatch.setattr(config, "load_incluster_config", lambda: None)
    module = importlib.import_module("main")
    return importlib.reload(module)


def test_image_pull_secret_names_support_legacy_and_csv(generator, monkeypatch):
    monkeypatch.setenv("IMAGE_PULL_SECRET_NAMES", "harbor-a, harbor-b")
    monkeypatch.setenv("IMAGE_PULL_SECRET_NAME", "harbor-a")

    assert generator.get_image_pull_secret_names() == ["harbor-a", "harbor-b"]


def test_code_server_args_are_shell_split(generator, monkeypatch):
    monkeypatch.setenv(
        "CODE_SERVER_ARGS",
        '--bind-addr 0.0.0.0:8080 --app-name "JCode IDE" /home/coder/project',
    )

    assert generator.get_code_server_args(False) == [
        "--bind-addr",
        "0.0.0.0:8080",
        "--app-name",
        "JCode IDE",
        "/home/coder/project",
    ]


def test_ensure_image_pull_secrets_copies_configured_secret(generator, monkeypatch):
    monkeypatch.setenv("IMAGE_PULL_SECRET_NAMES", "harbor-jcode-pull")
    monkeypatch.setenv("IMAGE_PULL_SECRET_SOURCE_NAMESPACE", "watcher")

    class CoreV1:
        def __init__(self):
            self.created = []

        def read_namespaced_secret(self, name, namespace):
            if namespace == "jcode-course-1":
                raise generator.ApiException(status=404)
            return generator.client.V1Secret(
                metadata=generator.client.V1ObjectMeta(name=name),
                data={".dockerconfigjson": "encoded"},
                type="kubernetes.io/dockerconfigjson",
            )

        def create_namespaced_secret(self, namespace, body):
            self.created.append((namespace, body.metadata.name, body.data, body.type))

    core_v1 = CoreV1()
    generator.ensure_image_pull_secrets(core_v1, "jcode-course-1")

    assert core_v1.created == [
        (
            "jcode-course-1",
            "harbor-jcode-pull",
            {".dockerconfigjson": "encoded"},
            "kubernetes.io/dockerconfigjson",
        )
    ]


def test_ensure_image_pull_secrets_skips_when_not_configured(generator, monkeypatch):
    monkeypatch.delenv("IMAGE_PULL_SECRET_NAMES", raising=False)
    monkeypatch.delenv("IMAGE_PULL_SECRET_NAME", raising=False)

    class CoreV1:
        def read_namespaced_secret(self, name, namespace):
            raise AssertionError("secret API should not be called")

        def create_namespaced_secret(self, namespace, body):
            raise AssertionError("secret API should not be called")

    generator.ensure_image_pull_secrets(CoreV1(), "jcode-course-1")


def test_watcher_hook_config_is_created_and_contains_dynamic_assignment_lookup(generator):
    class CoreV1:
        def __init__(self):
            self.created = None

        def read_namespaced_config_map(self, name, namespace):
            raise generator.ApiException(status=404)

        def create_namespaced_config_map(self, namespace, body):
            self.created = body

    core_v1 = CoreV1()
    generator.ensure_watcher_hook_config(core_v1, "jcode-course-1")

    assert core_v1.created.metadata.name == "watcher-hook-config"
    hook = core_v1.created.data["99-watcher-hook.py"]
    assert "relative_to(WORKSPACE_ROOT)" in hook
    assert "post_with_retry" in hook


def test_managed_config_map_is_replaced_with_resource_version(generator):
    class CoreV1:
        def __init__(self):
            self.replaced = None

        def read_namespaced_config_map(self, name, namespace):
            return generator.client.V1ConfigMap(
                metadata=generator.client.V1ObjectMeta(
                    name=name,
                    namespace=namespace,
                    resource_version="17",
                ),
                data={"old": "value"},
            )

        def replace_namespaced_config_map(self, name, namespace, body):
            self.replaced = body

    core_v1 = CoreV1()
    generator.ensure_code_server_config(core_v1, "jcode-course-1")

    assert core_v1.replaced.metadata.resource_version == "17"
    assert "config.yaml" in core_v1.replaced.data
