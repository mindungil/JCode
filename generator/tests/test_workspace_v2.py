import asyncio
import errno
import io
import json
import os
import stat
import time
import zipfile
from types import SimpleNamespace

import pytest


def make_zip(path, files):
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)


def test_stale_nfs_lock_replacement_never_lets_old_owner_remove_new_lock(generator, tmp_path):
    lock = tmp_path / "workspace.lock"
    old_owner = generator.try_acquire_directory_lock(lock, 300)
    assert old_owner is not None
    stale_time = time.time() - 600
    os.utime(lock, (stale_time, stale_time))

    new_owner = generator.try_acquire_directory_lock(lock, 300)
    assert new_owner is not None
    assert new_owner != old_owner

    with generator.keep_directory_lock_alive(lock, 300, old_owner):
        pass
    assert lock.is_dir()
    assert generator.read_lock_owner(lock) == new_owner

    with generator.keep_directory_lock_alive(lock, 300, new_owner):
        pass
    assert not lock.exists()


def test_environment_profiles_reject_inconsistent_presets(generator):
    with pytest.raises(generator.HTTPException) as error:
        generator.validate_workspace_profile(
            "ALGORITHM", True, False, None, "STANDARD", "PACKAGE_PROXY", "COURSE"
        )
    assert error.value.status_code == 409

    generator.validate_workspace_profile(
        "LAB", True, True, None, "STANDARD", "PACKAGE_PROXY", "COURSE"
    )


def test_inspector_session_must_be_assignment_scoped_and_read_only(generator):
    request = generator.DeployRequest(
        course_id=1,
        namespace="jcode-os-1",
        deployment_name="jinspect-1",
        service_name="jinspect-1-svc",
        app_label="jinspect-1",
        file_path="workspace/os-1-20260001",
        student_num="20260001",
        use_vnc=False,
        workspace_scope="ASSIGNMENT",
        assignment_workspace_key="assignment-7",
        use_snapshot=False,
        mount_hash="0" * 64,
        session_kind="INSPECTOR",
        read_only_workspace=True,
    )

    generator.validate_deploy_session(request)
    with pytest.raises(generator.HTTPException):
        generator.validate_deploy_session(request.model_copy(update={"read_only_workspace": False}))
    with pytest.raises(generator.HTTPException):
        generator.validate_deploy_session(request.model_copy(update={"workspace_scope": "COURSE"}))


def test_legacy_snapshot_request_is_normalized_during_rolling_upgrade(generator):
    request = generator.DeployRequest(
        course_id=1,
        namespace="jcode-os-1",
        deployment_name="jcode-snapshot-os-20260001",
        service_name="jcode-snapshot-os-20260001-svc",
        app_label="jcode-snapshot-os-20260001",
        file_path="os-1",
        student_num="20260001",
        use_vnc=False,
        workspace_scope="ASSIGNMENT",
        use_snapshot=True,
        mount_hash="0" * 64,
    )

    generator.validate_deploy_session(request)

    assert request.session_kind == "SNAPSHOT"


def test_course_namespace_annotations_are_human_readable(generator, monkeypatch):
    monkeypatch.setattr(generator, "JCODE_ENVIRONMENT", "prod")

    annotations = generator.course_namespace_annotations(
        61, "자료 구조", "홍길동", 2026, 2, 3
    )

    assert annotations == {
        "jcode.io/course-id": "61",
        "jcode.io/environment": "prod",
        "jcode.io/course-name": "자료 구조",
        "jcode.io/professor-name": "홍길동",
        "jcode.io/display-name": "2026-2 | 자료 구조 | 홍길동 | 3분반",
    }


def test_course_namespace_annotations_reject_control_characters(generator):
    with pytest.raises(generator.HTTPException) as error:
        generator.course_namespace_annotations(61, "자료\n구조", "홍길동", 2026, 2, 3)

    assert error.value.status_code == 422


def test_namespace_metadata_api_updates_existing_course_namespace(generator, monkeypatch):
    class CoreV1:
        patch = None

        def read_namespace(self, name):
            return SimpleNamespace(
                metadata=SimpleNamespace(
                    annotations={
                        "jcode.io/course-id": "61",
                        "jcode.io/environment": generator.JCODE_ENVIRONMENT,
                    },
                    labels={
                        "jcode.io/course-id": "61",
                        "jcode.io/environment": generator.JCODE_ENVIRONMENT,
                    },
                )
            )

        def patch_namespace(self, name, body):
            self.patch = (name, body)

    core = CoreV1()
    monkeypatch.setattr(generator.client, "CoreV1Api", lambda: core)
    request = generator.NamespaceMetadataRequest(
        course_id=61,
        course_name="자료 구조",
        professor_name="홍길동",
        year=2026,
        term=2,
        class_section=3,
    )

    response = asyncio.run(
        generator.update_namespace_metadata_api("jcode-ab12cd34ef56-3", request, {})
    )

    assert response["namespace"] == "jcode-ab12cd34ef56-3"
    annotations = core.patch[1]["metadata"]["annotations"]
    assert annotations["jcode.io/display-name"] == "2026-2 | 자료 구조 | 홍길동 | 3분반"


def test_custom_profile_requires_immutable_harbor_image(generator):
    with pytest.raises(RuntimeError):
        generator.validate_workspace_profile(
            "CUSTOM", False, True, "docker.io/example/latest", "GPU", "RESTRICTED", "ASSIGNMENT"
        )


def test_resource_profile_values_are_loaded_from_environment(generator, monkeypatch):
    monkeypatch.setenv(
        "WORKSPACE_RESOURCE_PROFILES_JSON",
        json.dumps({"STANDARD": {"requests": {"cpu": "100m"}, "limits": {"memory": "1Gi"}}}),
    )
    resources = generator.get_workspace_resources("STANDARD")
    assert resources.requests == {"cpu": "100m"}
    assert resources.limits == {"memory": "1Gi"}


def test_starter_distribution_preserves_or_replaces_student_files(generator, monkeypatch, tmp_path):
    monkeypatch.setattr(os, "chown", lambda *_: None)
    artifact = tmp_path / "starter.zip"
    make_zip(artifact, {"main.py": "starter", "new.txt": "new"})
    target = tmp_path / "assignment-1"
    target.mkdir()
    (target / "main.py").write_text("student", encoding="utf-8")

    generator.apply_starter_artifact(artifact, target, "PRESERVE_EXISTING")
    assert (target / "main.py").read_text(encoding="utf-8") == "student"
    assert (target / "new.txt").read_text(encoding="utf-8") == "new"

    generator.apply_starter_artifact(artifact, target, "REPLACE_ALL")
    assert (target / "main.py").read_text(encoding="utf-8") == "starter"

    with pytest.raises(generator.HTTPException, match="checksum"):
        generator.verify_artifact_checksum(artifact, "0" * 64)


def test_starter_replace_retry_does_not_overwrite_new_student_work(generator, monkeypatch, tmp_path):
    monkeypatch.setattr(os, "chown", lambda *_: None)
    artifact = tmp_path / "starter.zip"
    make_zip(artifact, {"main.py": "starter"})
    target = tmp_path / "assignment-1"
    operation_key = "00000000-0000-0000-0000-000000000042"

    assert generator.apply_starter_artifact(
        artifact, target, "REPLACE_ALL", operation_key
    ) is True
    (target / "main.py").write_text("student", encoding="utf-8")

    assert generator.apply_starter_artifact(
        artifact, target, "REPLACE_ALL", operation_key
    ) is False
    assert (target / "main.py").read_text(encoding="utf-8") == "student"


def test_starter_distribution_rejects_student_symlink(generator, monkeypatch, tmp_path):
    artifact = tmp_path / "starter.zip"
    make_zip(artifact, {"main.py": "starter"})
    outside = tmp_path / "outside"
    outside.mkdir()
    target_parent = tmp_path / "student"
    target_parent.mkdir()
    (target_parent / "assignment-1").symlink_to(outside, target_is_directory=True)
    monkeypatch.setattr(os, "chown", lambda *_: None)

    with pytest.raises(generator.HTTPException, match="symlink"):
        generator.apply_starter_artifact(artifact, target_parent / "assignment-1", "PRESERVE_EXISTING")


def test_starter_upload_validation_rejects_symlink_member(generator, tmp_path):
    artifact = tmp_path / "starter.zip"
    member = zipfile.ZipInfo("linked-file")
    member.create_system = 3
    member.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(artifact, "w") as archive:
        archive.writestr(member, "outside")

    with zipfile.ZipFile(artifact, "r") as archive:
        with pytest.raises(generator.HTTPException, match="symlink"):
            generator.validate_zip_archive(archive, str(tmp_path / "extract"))


def test_assignment_path_migration_is_idempotent_without_exposing_descriptor(generator, monkeypatch, tmp_path):
    workspace_root = tmp_path / "workspace"
    student = workspace_root / "os-1-20260001"
    legacy = student / "old-name"
    legacy.mkdir(parents=True)
    (legacy / "answer.py").write_text("pass", encoding="utf-8")
    monkeypatch.setattr(generator, "NFS_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setattr(generator, "resolve_namespace", lambda value: value)
    monkeypatch.setattr(generator, "verify_course_namespace", lambda *_: None)
    monkeypatch.setattr(generator.client, "CoreV1Api", lambda: object())
    monkeypatch.setattr(os, "chown", lambda *_: None)
    request = generator.AssignmentProvisionRequest(
        course_id=1,
        namespace="jcode-os-1",
        workspace_key="assignment-7",
        legacy_dir_name="old-name",
        display_name="자료구조 첫 과제",
    )

    operation_key = "00000000-0000-0000-0000-000000000071"
    first = asyncio.run(generator.provision_assignment_workspace(request, operation_key, {}))
    second = asyncio.run(generator.provision_assignment_workspace(request, operation_key, {}))

    assert first["migrated"] == 1
    assert first["completed"] is True
    assert second["migrated"] == 1
    assert second["created"] == 0
    assert second["completed"] is True
    assert (student / "assignment-7" / "answer.py").is_file()
    assert not (student / ".jcode" / "assignment-7.code-workspace").exists()

    renamed = request.model_copy(update={"display_name": "자료구조 수정 과제"})
    third = asyncio.run(generator.provision_assignment_workspace(
        renamed, "00000000-0000-0000-0000-000000000072", {}
    ))
    assert third["migrated"] == 0
    assert third["created"] == 0
    assert third["completed"] is True
    assert not (student / ".jcode" / "assignment-7.code-workspace").exists()


def test_general_workspace_shows_user_and_named_assignments(generator, monkeypatch, tmp_path):
    student = tmp_path / "workspace" / "os-1-20260001"
    (student / "assignment-7").mkdir(parents=True)
    (student / "assignment-9").mkdir()
    (student / "assignment-10").mkdir()
    (student / "hw1").mkdir()
    (student / "hw2").mkdir()
    (student / "hw2" / "answer.c").write_text("int main(void) {}", encoding="utf-8")
    (student / "prac1").mkdir()
    monkeypatch.setattr(os, "chown", lambda *_: None)

    generator.write_assignment_workspace_descriptor(student, "assignment-7", "자료구조 첫 과제")
    generator.write_assignment_workspace_descriptor(student, "assignment-9", "알고리즘 실습")
    generator.write_assignment_workspace_descriptor(student, "assignment-10", "마지막 과제")
    generator.write_general_workspace_descriptor(student, "홍길동")

    descriptor = json.loads((student / ".jcode" / "홍길동의 JCode.code-workspace").read_text())
    assert descriptor["folders"] == [
        {"name": "내 작업공간", "path": "../workspace"},
        {"name": "자료구조 첫 과제", "path": "../assignments/assignment-7"},
        {"name": "알고리즘 실습", "path": "../assignments/assignment-9"},
        {"name": "마지막 과제", "path": "../assignments/assignment-10"},
    ]
    assert descriptor["settings"]["chat.disableAIFeatures"] is True
    assert descriptor["settings"]["chat.commandCenter.enabled"] is False
    assert json.loads((student / ".jcode" / "jcode.code-workspace").read_text()) == descriptor
    assert (student / "workspace").is_dir()
    assert "과제명 폴더" in (student / "workspace" / "README.md").read_text(encoding="utf-8")
    assert not (student / "hw1").exists()
    assert not (student / "prac1").exists()
    assert (student / "hw2" / "answer.c").is_file()

    (student / "workspace" / "README.md").write_text("사용자 내용", encoding="utf-8")
    generator.write_general_workspace_descriptor(student, "홍길동")
    assert (student / "workspace" / "README.md").read_text(encoding="utf-8") == "사용자 내용"

    generator.remove_assignment_workspace_descriptor(student, "assignment-7")
    generator.remove_stale_assignment_workspace_descriptors(student, ["assignment-10"])
    generator.write_general_workspace_descriptor(student)
    descriptor = json.loads((student / ".jcode" / "홍길동의 JCode.code-workspace").read_text())
    assert descriptor["folders"] == [
        {"name": "내 작업공간", "path": "../workspace"},
        {"name": "마지막 과제", "path": "../assignments/assignment-10"},
    ]
    assert (student / "assignment-9").is_dir()
    assert not (student / ".jcode" / "assignment-9.code-workspace").exists()
    assert not (student / ".jcode" / "assignments" / "assignment-9").exists()


def test_workspace_operation_is_resumed_in_bounded_batches(generator, monkeypatch, tmp_path):
    workspace_root = tmp_path / "workspace"
    for student_number in ("20260001", "20260002"):
        (workspace_root / f"os-1-{student_number}").mkdir(parents=True)
    monkeypatch.setattr(generator, "NFS_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setenv("WORKSPACE_OPERATION_BATCH_SIZE", "1")
    processed = []

    def worker(student_dir):
        processed.append(student_dir.name)
        return {"changed": 1}

    first = generator.process_workspace_batch(
        "jcode-os-1", "00000000-0000-0000-0000-000000000081",
        "test-batch", "fingerprint", worker
    )
    second = generator.process_workspace_batch(
        "jcode-os-1", "00000000-0000-0000-0000-000000000081",
        "test-batch", "fingerprint", worker
    )
    third = generator.process_workspace_batch(
        "jcode-os-1", "00000000-0000-0000-0000-000000000081",
        "test-batch", "fingerprint", worker
    )

    assert first == {
        "completed": False,
        "processed": 1,
        "processed_students": ["os-1-20260001"],
        "total": 2,
        "changed": 1,
    }
    assert second == {
        "completed": True,
        "processed": 2,
        "processed_students": ["os-1-20260001", "os-1-20260002"],
        "total": 2,
        "changed": 2,
    }
    assert third == second
    assert processed == ["os-1-20260001", "os-1-20260002"]


def test_workspace_batch_reprocesses_recreated_student_directory(generator, monkeypatch, tmp_path):
    workspace_root = tmp_path / "workspace"
    student = workspace_root / "os-1-20260001"
    student.mkdir(parents=True)
    monkeypatch.setattr(generator, "NFS_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setattr(os, "chown", lambda *_: None)
    processed = []

    def worker(student_dir):
        processed.append(student_dir.name)
        return {"changed": 1}

    operation_key = "00000000-0000-0000-0000-000000000082"
    first = generator.process_workspace_batch(
        "jcode-os-1", operation_key, "test-recreated", "fingerprint", worker
    )
    old_identity = generator.read_workspace_identity(student)
    archived = tmp_path / "archived-student"
    student.rename(archived)
    student.mkdir()
    second = generator.process_workspace_batch(
        "jcode-os-1", operation_key, "test-recreated", "fingerprint", worker
    )

    assert first["completed"] is True
    assert second["completed"] is True
    assert generator.read_workspace_identity(student) != old_identity
    assert processed == ["os-1-20260001", "os-1-20260001"]


def test_general_workspace_filename_rejects_path_characters(generator):
    with pytest.raises(generator.HTTPException, match="파일명"):
        generator.general_workspace_filename("다른/사용자")


def test_student_archive_continues_when_namespace_is_already_missing(generator, monkeypatch, tmp_path):
    class MissingNamespace:
        def read_namespace(self, name):
            raise generator.ApiException(status=404)

        def read_namespaced_config_map(self, name, namespace):
            raise AssertionError("missing namespace must not require a namespaced permission check")

    workspace_root = tmp_path / "workspace"
    source = workspace_root / "os-1-20260001"
    source.mkdir(parents=True)
    (source / "answer.py").write_text("pass", encoding="utf-8")
    archive_root = tmp_path / "archive"
    monkeypatch.setattr(generator, "NFS_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setattr(generator, "get_workspace_archive_root", lambda: archive_root)
    monkeypatch.setattr(generator.client, "CoreV1Api", MissingNamespace)
    monkeypatch.setattr(
        generator.client,
        "AppsV1Api",
        lambda: (_ for _ in ()).throw(AssertionError("Kubernetes cleanup must be skipped")),
    )
    request = generator.StudentArchiveRequest(
        course_id=1,
        namespace="jcode-os-1",
        student_num="20260001",
        archive_key="12345678-1234-1234-1234-123456789abc",
    )

    response = asyncio.run(generator.archive_student_workspace(
        request, "00000000-0000-0000-0000-000000000091", {}
    ))

    destination = archive_root / "memberships" / "os-1" / "20260001" / request.archive_key
    assert response["archived"] is True
    assert not source.exists()
    assert (destination / "answer.py").read_text(encoding="utf-8") == "pass"


def test_student_archive_does_not_touch_a_reused_namespace(generator, monkeypatch, tmp_path):
    class ReusedNamespace:
        def read_namespace(self, name):
            return SimpleNamespace(
                metadata=SimpleNamespace(
                    annotations={"jcode.io/course-id": "2"},
                    labels={"jcode.io/course-id": "2"},
                )
            )

        def read_namespaced_config_map(self, name, namespace):
            raise AssertionError("reused namespace must not use old course permissions")

    monkeypatch.setattr(generator, "NFS_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setattr(generator, "get_workspace_archive_root", lambda: tmp_path / "archive")
    monkeypatch.setattr(generator.client, "CoreV1Api", ReusedNamespace)
    monkeypatch.setattr(
        generator.client,
        "AppsV1Api",
        lambda: (_ for _ in ()).throw(AssertionError("reused namespace must not be modified")),
    )
    request = generator.StudentArchiveRequest(
        course_id=1,
        namespace="jcode-os-1",
        student_num="20260001",
        archive_key="12345678-1234-1234-1234-123456789abc",
    )

    response = asyncio.run(generator.archive_student_workspace(
        request, "00000000-0000-0000-0000-000000000092", {}
    ))

    assert response == {
        "archived": True,
        "archive_key": request.archive_key,
        "namespace_reused": True,
    }


def test_archive_move_supports_different_filesystems(generator, monkeypatch, tmp_path):
    source = tmp_path / "workspace" / "assignment-1"
    destination = tmp_path / "archive" / "assignment-1"
    source.mkdir(parents=True)
    (source / "answer.py").write_text("pass", encoding="utf-8")
    original_rename = generator.Path.rename

    def cross_device_rename(path, target):
        if path == source:
            raise OSError(errno.EXDEV, "cross-device link")
        return original_rename(path, target)

    monkeypatch.setattr(generator.Path, "rename", cross_device_rename)
    generator.move_directory_safely(source, destination, {"retention_days": 90})

    assert not source.exists()
    assert (destination / "answer.py").read_text(encoding="utf-8") == "pass"
    assert json.loads((destination / ".retention.json").read_text())["retention_days"] == 90


def test_reopen_prepares_workspace_for_student_without_final_archive(generator, monkeypatch, tmp_path):
    workspace_root = tmp_path / "workspace"
    student = workspace_root / "os-1-20260001"
    student.mkdir(parents=True)
    artifact = tmp_path / "starter.zip"
    make_zip(artifact, {"main.py": "starter"})
    monkeypatch.setattr(generator, "NFS_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setattr(generator, "get_workspace_archive_root", lambda: tmp_path / "archive")
    monkeypatch.setattr(os, "chown", lambda *_: None)

    moved = generator.move_assignment_between_workspace_and_final_archive(
        "jcode-os-1",
        "assignment-7",
        90,
        restore=True,
        starter_artifact=artifact,
    )

    assert moved == 1
    assert (student / "assignment-7" / "main.py").read_text(encoding="utf-8") == "starter"
    assert not (student / ".jcode" / "assignment-7.code-workspace").exists()


def test_reopen_rejects_existing_workspace_when_final_archive_is_missing(generator, monkeypatch, tmp_path):
    student = tmp_path / "workspace" / "os-1-20260001"
    assignment = student / "assignment-7"
    assignment.mkdir(parents=True)
    (assignment / "answer.py").write_text("unverified", encoding="utf-8")
    monkeypatch.setattr(generator, "NFS_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setattr(generator, "get_workspace_archive_root", lambda: tmp_path / "archive")

    with pytest.raises(generator.HTTPException) as error:
        generator.move_assignment_between_workspace_and_final_archive(
            "jcode-os-1",
            "assignment-7",
            90,
            restore=True,
        )

    assert error.value.status_code == 409


def test_finalization_copies_an_immutable_generation_without_moving_student_work(generator, monkeypatch, tmp_path):
    student = tmp_path / "workspace" / "os-1-20260001"
    assignment = student / "assignment-7"
    assignment.mkdir(parents=True)
    (assignment / "answer.py").write_text("first", encoding="utf-8")
    monkeypatch.setattr(generator, "NFS_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr(generator, "COURSE_NAMESPACE_PREFIX", "jcode-")
    monkeypatch.setattr(generator, "get_workspace_archive_root", lambda: tmp_path / "archive")

    copied = generator.move_assignment_between_workspace_and_final_archive(
        "jcode-os-1", "assignment-7", 90, restore=False, finalization_generation=2
    )

    final = tmp_path / "archive" / "final" / "os-1" / "assignment-7" / "2" / student.name
    assert copied == 1
    assert (assignment / "answer.py").read_text(encoding="utf-8") == "first"
    assert (final / "answer.py").read_text(encoding="utf-8") == "first"
    assert json.loads((final / ".retention.json").read_text())["finalization_generation"] == 2
