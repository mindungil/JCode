import asyncio
import json
import os
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


READ_ONLY_PATTERN = "/home/coder/project/assignments/{}/**"


def deploy_request(generator, **overrides):
    values = {
        "course_id": 1,
        "namespace": "jcode-os-1",
        "deployment_name": "jcode-os-1-20260001",
        "service_name": "jcode-os-1-20260001-svc",
        "app_label": "jcode-os-1-20260001",
        "file_path": "workspace/os-1-20260001",
        "student_num": "20260001",
        "use_vnc": False,
        "use_snapshot": False,
        "workspace_display_name": "홍길동",
        "assignment_dirs": ["assignment-9"],
        "read_only_assignment_dirs": ["assignment-7", "assignment-8"],
        "assignment_labels": {"assignment-7": "첫 과제", "assignment-8": "둘째 과제", "assignment-9": "진행 과제"},
        "mount_hash": "a" * 64,
    }
    values.update(overrides)
    return generator.DeployRequest(**values)


@pytest.fixture()
def deploy_env(generator, monkeypatch, tmp_path):
    captured = {}
    monkeypatch.setattr(os, "chown", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setattr(generator, "resolve_namespace", lambda namespace: namespace)
    monkeypatch.setattr(generator, "verify_course_namespace", lambda *_: None)
    monkeypatch.setattr(generator, "validate_workspace_profile", lambda *_: None)
    monkeypatch.setattr(generator, "get_nfs_workspace_path", lambda: tmp_path / "workspace")
    monkeypatch.setattr(generator, "student_workspace_lock", lambda *_: nullcontext())
    monkeypatch.setattr(generator, "prepare_workspace_extension", lambda *_: None)
    monkeypatch.setattr(generator, "ensure_code_server_config", lambda *_: None)
    monkeypatch.setattr(generator.client, "CoreV1Api", lambda: SimpleNamespace())
    monkeypatch.setattr(generator.client, "AppsV1Api", lambda: SimpleNamespace())
    monkeypatch.setattr(generator, "create_service", lambda *_: "service")

    def create_deployment(*args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return "deployment"

    monkeypatch.setattr(generator, "create_deployment", create_deployment)
    student = tmp_path / "workspace" / "os-1-20260001"
    (student / "assignment-7").mkdir(parents=True)
    (student / "assignment-7" / "answer.py").write_text("print(1)", encoding="utf-8")
    return SimpleNamespace(student=student, captured=captured)


def test_closed_assignment_is_mounted_read_only_without_creating_missing_directories(generator, deploy_env):
    asyncio.run(generator.deploy_resources(deploy_request(generator), token_payload={}))

    args = deploy_env.captured["args"]
    # assignment_dirs stays writable-only; closed directories are mounted read-only and a
    # missing one is replaced by the empty placeholder instead of being created.
    assert args[10] == ["assignment-9"]
    assert args[-3] == ["assignment-7"]
    assert args[-2] == ["assignment-8"]
    assert args[-1] is False
    assert (deploy_env.student / "assignment-9").is_dir()
    assert not (deploy_env.student / "assignment-8").exists()
    assert (deploy_env.student / ".jcode" / "closed-assignment-empty").is_dir()
    assert (deploy_env.student / "assignment-7" / "answer.py").read_text(encoding="utf-8") == "print(1)"

    metadata = deploy_env.student / ".jcode"
    closed = json.loads((metadata / "assignment-7.code-workspace").read_text(encoding="utf-8"))
    assert closed["folders"] == [{"name": "첫 과제 (마감)", "path": "../assignments/assignment-7"}]
    assert closed["settings"]["files.readonlyInclude"] == {READ_ONLY_PATTERN.format("assignment-7"): True}
    # Backend derives the launch file from the plain assignment name.
    named = metadata / "assignments" / "assignment-7" / "첫 과제.code-workspace"
    assert json.loads(named.read_text(encoding="utf-8"))["folders"][0]["name"] == "첫 과제 (마감)"
    open_descriptor = json.loads((metadata / "assignment-9.code-workspace").read_text(encoding="utf-8"))
    assert "files.readonlyInclude" not in open_descriptor["settings"]

    general = json.loads((metadata / "홍길동의 JCode.code-workspace").read_text(encoding="utf-8"))
    assert general["folders"] == [
        {"name": "내 작업공간", "path": "../workspace"},
        {"name": "첫 과제 (마감)", "path": "../assignments/assignment-7"},
        {"name": "둘째 과제 (마감)", "path": "../assignments/assignment-8"},
        {"name": "진행 과제", "path": "../assignments/assignment-9"},
    ]
    assert general["settings"]["files.readonlyInclude"] == {
        READ_ONLY_PATTERN.format("assignment-7"): True,
        READ_ONLY_PATTERN.format("assignment-8"): True,
    }


def test_reopened_assignment_becomes_writable_again(generator, deploy_env):
    asyncio.run(generator.deploy_resources(deploy_request(generator), token_payload={}))
    asyncio.run(generator.deploy_resources(deploy_request(
        generator,
        assignment_dirs=["assignment-7", "assignment-9"],
        read_only_assignment_dirs=[],
        assignment_labels={"assignment-7": "첫 과제", "assignment-9": "진행 과제"},
    ), token_payload={}))

    metadata = deploy_env.student / ".jcode"
    reopened = json.loads((metadata / "assignment-7.code-workspace").read_text(encoding="utf-8"))
    assert reopened["folders"][0]["name"] == "첫 과제"
    assert "files.readonlyInclude" not in reopened["settings"]
    assert not (metadata / "assignment-8.code-workspace").exists()
    general = json.loads((metadata / "홍길동의 JCode.code-workspace").read_text(encoding="utf-8"))
    assert "files.readonlyInclude" not in general["settings"]
    assert [folder["path"] for folder in general["folders"]] == [
        "../workspace", "../assignments/assignment-7", "../assignments/assignment-9",
    ]
    assert deploy_env.captured["args"][-3:] == ([], [], False)


@pytest.mark.parametrize(
    "overrides",
    [
        {"read_only_assignment_dirs": ["assignment-9"]},
        {"read_only_assignment_dirs": ["assignment-7", "assignment-7"]},
        {"assignment_labels": {"assignment-5": "모르는 과제"}},
    ],
)
def test_read_only_assignment_contract_is_validated(generator, deploy_env, overrides):
    with pytest.raises(HTTPException) as error:
        asyncio.run(generator.deploy_resources(deploy_request(generator, **overrides), token_payload={}))
    assert error.value.status_code == 400


@pytest.mark.parametrize(
    "overrides",
    [
        {"use_snapshot": True, "session_kind": "SNAPSHOT"},
        {"workspace_scope": "ASSIGNMENT", "assignment_workspace_key": "assignment-9"},
        {
            "session_kind": "INSPECTOR",
            "workspace_scope": "ASSIGNMENT",
            "assignment_workspace_key": "assignment-9",
            "read_only_workspace": True,
        },
    ],
)
def test_read_only_assignments_are_only_for_course_sessions(generator, overrides):
    request = deploy_request(generator, **overrides)
    with pytest.raises(HTTPException) as error:
        generator.validate_deploy_session(request)
    assert error.value.status_code == 409


def test_metadata_update_keeps_closed_assignment_read_only(generator, monkeypatch, tmp_path):
    student = tmp_path / "workspace" / "os-1-20260001"
    (student / "assignment-7").mkdir(parents=True)
    monkeypatch.setattr(os, "chown", lambda *_args, **_kwargs: None)

    generator.write_assignment_workspace_descriptor(student, "assignment-7", "첫 과제", read_only=True)
    generator.write_assignment_workspace_descriptor(student, "assignment-7", "이름 바뀐 과제")

    descriptor = json.loads((student / ".jcode" / "assignment-7.code-workspace").read_text(encoding="utf-8"))
    assert descriptor["folders"][0]["name"] == "이름 바뀐 과제 (마감)"
    assert descriptor["settings"]["files.readonlyInclude"] == {READ_ONLY_PATTERN.format("assignment-7"): True}


def test_read_only_label_stays_within_descriptor_limit(generator, monkeypatch, tmp_path):
    student = tmp_path / "workspace" / "os-1-20260001"
    (student / "assignment-7").mkdir(parents=True)
    monkeypatch.setattr(os, "chown", lambda *_args, **_kwargs: None)
    name = "가" * 50

    generator.write_assignment_workspace_descriptor(student, "assignment-7", name, read_only=True)
    generator.write_general_workspace_descriptor(student, "홍길동")

    general = json.loads((student / ".jcode" / "홍길동의 JCode.code-workspace").read_text(encoding="utf-8"))
    label = general["folders"][1]["name"]
    assert len(label) == 50 and label.endswith(" (마감)")
    assert (student / ".jcode" / "assignments" / "assignment-7" / f"{name}.code-workspace").is_file()


def test_finalization_can_retain_closed_assignment_descriptors(generator, monkeypatch, tmp_path):
    student = tmp_path / "workspace" / "os-1-20260001"
    (student / "assignment-7").mkdir(parents=True)
    (student / "assignment-7" / "answer.py").write_text("final", encoding="utf-8")
    monkeypatch.setattr(os, "chown", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(generator, "NFS_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setattr(generator, "get_workspace_archive_root", lambda: tmp_path / "archive")
    generator.write_assignment_workspace_descriptor(student, "assignment-7", "첫 과제", read_only=True)

    copied = generator.move_assignment_between_workspace_and_final_archive(
        "jcode-os-1", "assignment-7", 90, restore=False, finalization_generation=1, retain_descriptors=True
    )

    assert copied == 1
    assert (student / ".jcode" / "assignment-7.code-workspace").is_file()
    assert (tmp_path / "archive" / "final" / "os-1" / "assignment-7" / "1" / student.name / "answer.py").is_file()

    # Even a Backend that does not ask to retain must not drop a read-only descriptor.
    generator.move_assignment_between_workspace_and_final_archive(
        "jcode-os-1", "assignment-7", 90, restore=False, finalization_generation=2
    )
    assert (student / ".jcode" / "assignment-7.code-workspace").is_file()

    generator.write_assignment_workspace_descriptor(student, "assignment-7", "첫 과제", read_only=False)
    generator.move_assignment_between_workspace_and_final_archive(
        "jcode-os-1", "assignment-7", 90, restore=False, finalization_generation=3
    )
    assert not (student / ".jcode" / "assignment-7.code-workspace").exists()


def test_retain_flag_does_not_change_existing_operation_ledgers(generator):
    base = {"course_id": 1, "namespace": "jcode-os-1", "workspace_key": "assignment-7"}
    legacy = generator.operation_fingerprint(
        "finalize-assignment", generator.AssignmentArchiveRequest(**base)
    )
    retained = generator.operation_fingerprint(
        "finalize-assignment", generator.AssignmentArchiveRequest(**base, retain_workspace_descriptors=True)
    )
    assert legacy == retained


def test_contract_advertises_read_only_assignment_mounts(generator):
    contract = generator.health_contract()
    assert contract["workspaceContractVersion"] == "3"
    assert "closed-assignment-read-only-mounts" in contract["features"]


def test_read_only_assignment_mounts_are_not_given_to_init_container(generator, monkeypatch):
    class AppsV1:
        def __init__(self):
            self.deployment = None

        def create_namespaced_deployment(self, namespace, body):
            self.deployment = body

    monkeypatch.setattr(generator, "get_requested_workspace_image", lambda *_: "harbor/image@sha256:" + "a" * 64)
    monkeypatch.setattr(generator, "get_workspace_init_image", lambda: "harbor/init@sha256:" + "b" * 64)
    monkeypatch.setattr(generator, "get_workspace_resources", lambda *_: generator.client.V1ResourceRequirements())
    monkeypatch.setattr(generator, "get_image_pull_secret_names", lambda: [])
    apps = AppsV1()

    generator.create_deployment(
        apps,
        "jcode-alg-1",
        "jcode-alg-1-20260001",
        "jcode-alg-1-20260001",
        "workspace/alg-1-20260001",
        "20260001",
        False,
        False,
        assignment_dirs=["assignment-9"],
        read_only_assignment_dirs=["assignment-7"],
        empty_read_only_assignment_dirs=["assignment-8"],
    )

    pod_spec = apps.deployment.spec.template.spec
    runtime_mounts = {
        mount.mount_path: mount
        for mount in pod_spec.containers[0].volume_mounts
        if mount.mount_path.startswith("/home/coder/project/assignments/")
    }
    assert runtime_mounts["/home/coder/project/assignments/assignment-7"].read_only is True
    assert runtime_mounts["/home/coder/project/assignments/assignment-7"].sub_path == "workspace/alg-1-20260001/assignment-7"
    assert not runtime_mounts["/home/coder/project/assignments/assignment-9"].read_only
    placeholder = runtime_mounts["/home/coder/project/assignments/assignment-8"]
    assert placeholder.read_only is True
    assert placeholder.sub_path == "workspace/alg-1-20260001/.jcode/closed-assignment-empty"
    init_paths = {mount.mount_path for mount in pod_spec.init_containers[0].volume_mounts}
    assert "/home/coder/project/assignments/assignment-7" not in init_paths
    assert "/home/coder/project/assignments/assignment-8" not in init_paths
    assert "/home/coder/project/assignments/assignment-9" in init_paths


def test_read_only_editor_pattern_follows_the_mount_path(generator, monkeypatch, tmp_path):
    student = tmp_path / "workspace" / "os-1-20260001"
    (student / "assignment-7").mkdir(parents=True)
    monkeypatch.setattr(os, "chown", lambda *_args, **_kwargs: None)
    monkeypatch.setenv("WORKSPACE_ROOT", "/home/coder/project/course")

    generator.write_assignment_workspace_descriptor(student, "assignment-7", "첫 과제", read_only=True)

    descriptor = json.loads((student / ".jcode" / "assignment-7.code-workspace").read_text(encoding="utf-8"))
    assert descriptor["settings"]["files.readonlyInclude"] == {
        f"{generator.ASSIGNMENT_MOUNT_ROOT}/assignment-7/**": True
    }


def test_empty_placeholder_explains_why_it_is_empty(generator, deploy_env):
    asyncio.run(generator.deploy_resources(deploy_request(generator), token_payload={}))

    readme = deploy_env.student / ".jcode" / "closed-assignment-empty" / "README.md"
    assert "마감 시점 파일이 없습니다" in readme.read_text(encoding="utf-8")


def test_inspector_never_lets_kubelet_create_a_missing_student_directory(generator, deploy_env):
    inspector = dict(
        session_kind="INSPECTOR", workspace_scope="ASSIGNMENT", read_only_workspace=True,
        assignment_workspace_key="assignment-8", assignment_dirs=["assignment-8"],
        read_only_assignment_dirs=[], assignment_labels={},
    )
    asyncio.run(generator.deploy_resources(deploy_request(generator, **inspector), token_payload={}))
    assert deploy_env.captured["args"][-1] is True
    assert not (deploy_env.student / "assignment-8").exists()

    asyncio.run(generator.deploy_resources(
        deploy_request(generator, **{**inspector, "assignment_workspace_key": "assignment-7", "assignment_dirs": ["assignment-7"]}),
        token_payload={},
    ))
    assert deploy_env.captured["args"][-1] is False


def test_inspector_placeholder_mount_is_read_only(generator, monkeypatch):
    class AppsV1:
        def create_namespaced_deployment(self, namespace, body):
            self.deployment = body

    monkeypatch.setattr(generator, "get_requested_workspace_image", lambda *_: "harbor/image@sha256:" + "a" * 64)
    monkeypatch.setattr(generator, "get_workspace_init_image", lambda: "harbor/init@sha256:" + "b" * 64)
    monkeypatch.setattr(generator, "get_workspace_resources", lambda *_: generator.client.V1ResourceRequirements())
    monkeypatch.setattr(generator, "get_image_pull_secret_names", lambda: [])
    apps = AppsV1()
    generator.create_deployment(
        apps, "jcode-alg-1", "jinspect-1", "jinspect-1", "workspace/alg-1-20260001", "20260001", False, False,
        workspace_scope="ASSIGNMENT", assignment_workspace_key="assignment-8", session_kind="INSPECTOR",
        read_only_workspace=True, assignment_placeholder=True,
    )
    mount = next(m for m in apps.deployment.spec.template.spec.containers[0].volume_mounts if m.mount_path == "/home/coder/project")
    assert mount.sub_path == "workspace/alg-1-20260001/.jcode/closed-assignment-empty"
    assert mount.read_only is True
    with pytest.raises(HTTPException):
        generator.create_deployment(
            apps, "jcode-alg-1", "jcode-1", "jcode-1", "workspace/alg-1-20260001", "20260001", False, False,
            workspace_scope="ASSIGNMENT", assignment_workspace_key="assignment-8", assignment_placeholder=True,
        )
