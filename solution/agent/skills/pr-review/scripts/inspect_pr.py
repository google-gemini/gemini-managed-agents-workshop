#!/usr/bin/env python3
"""Sandboxed GitHub PR checkout, test detection, and bounded test execution CLI."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
MAX_OUTPUT_CHARS = 4000


def emit(payload: dict[str, Any], exit_code: int = 0) -> None:
    print(json.dumps(payload, indent=2))
    sys.exit(exit_code)


def clip(text: str, limit: int = MAX_OUTPUT_CHARS) -> str:
    cleaned = text.strip()
    if len(cleaned) <= limit:
        return cleaned
    half = (limit - 40) // 2
    return f"{cleaned[:half]}\n... [truncated {len(cleaned) - limit} chars] ...\n{cleaned[-half:]}"


def safe_env(cwd: Path | None = None) -> dict[str, str]:
    env = dict(os.environ)
    env["CI"] = "1"
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    env["NO_COLOR"] = "1"
    if cwd is not None:
        existing_pp = env.get("PYTHONPATH", "")
        env["PYTHONPATH"] = f"{cwd}{os.pathsep}{existing_pp}" if existing_pp else str(cwd)
    return env


def validate_repo(repo: str) -> str:
    value = repo.strip()
    if not REPO_PATTERN.match(value) or ".." in value or value.startswith("-"):
        emit({"ok": False, "error": f"Invalid owner/repo format: {value!r}"}, 2)
    return value


def resolve_workdir(raw_dir: str) -> Path:
    target = Path(raw_dir).resolve()
    allowed_roots = [Path("/workspace").resolve(), (Path.cwd() / "tmp").resolve()]
    for root in allowed_roots:
        if target == root or str(target).startswith(str(root) + os.sep):
            return target
    emit(
        {
            "ok": False,
            "error": f"Directory {str(target)!r} must stay inside /workspace (or ./tmp when testing locally).",
        },
        2,
    )
    raise AssertionError("unreachable")


def run_cmd(
    argv: list[str],
    cwd: Path,
    timeout_sec: int = 90,
) -> tuple[int, str, str, int]:
    started = time.monotonic()
    try:
        proc = subprocess.run(
            argv,
            cwd=str(cwd),
            env=safe_env(cwd),
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
        elapsed_ms = int((time.monotonic() - started) * 1000)
        return proc.returncode, proc.stdout, proc.stderr, elapsed_ms
    except subprocess.TimeoutExpired as exc:
        elapsed_ms = int((time.monotonic() - started) * 1000)
        out = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout or b"").decode("utf-8", "replace")
        err = exc.stderr if isinstance(exc.stderr, str) else (exc.stderr or b"").decode("utf-8", "replace")
        return 124, out, f"{err}\nTimed out after {timeout_sec}s.".strip(), elapsed_ms


def cmd_clone_pr(args: argparse.Namespace) -> None:
    repo = validate_repo(args.repo)
    pr_num = int(args.pr)
    if pr_num < 1 or pr_num > 10_000_000:
        emit({"ok": False, "error": "PR number must be a positive integer."}, 2)

    workdir = resolve_workdir(args.dir)
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    remote_url = f"https://github.com/{repo}.git"
    branch_name = f"pr-{pr_num}"

    steps = [
        ["git", "init", "-q"],
        ["git", "remote", "add", "origin", "--", remote_url],
        ["git", "fetch", "--quiet", "--depth", "20", "origin", f"pull/{pr_num}/head:{branch_name}"],
        ["git", "checkout", "-q", branch_name],
    ]
    for step in steps:
        code, out, err, _ = run_cmd(step, cwd=workdir, timeout_sec=90)
        if code != 0:
            emit(
                {
                    "ok": False,
                    "repo": repo,
                    "pr": pr_num,
                    "step": " ".join(step[:3]),
                    "exit_code": code,
                    "stderr": clip(err or out),
                },
                1,
            )

    _, sha_out, _, _ = run_cmd(["git", "rev-parse", "HEAD"], cwd=workdir, timeout_sec=15)
    _, subj_out, _, _ = run_cmd(["git", "log", "-1", "--pretty=%s"], cwd=workdir, timeout_sec=15)
    _, author_out, _, _ = run_cmd(["git", "log", "-1", "--pretty=%an"], cwd=workdir, timeout_sec=15)
    _, stat_out, _, _ = run_cmd(["git", "show", "--stat", "--format=", "HEAD"], cwd=workdir, timeout_sec=15)
    _, files_out, _, _ = run_cmd(["git", "show", "--name-only", "--format=", "HEAD"], cwd=workdir, timeout_sec=15)

    changed_files = [line.strip() for line in files_out.splitlines() if line.strip()][:100]
    emit(
        {
            "ok": True,
            "repo": repo,
            "pr": pr_num,
            "dir": str(workdir),
            "head_sha": sha_out.strip(),
            "subject": subj_out.strip(),
            "author": author_out.strip(),
            "changed_files": changed_files,
            "stat": clip(stat_out, 2000),
        }
    )


def detect_runners(workdir: Path) -> tuple[list[dict[str, Any]], list[str] | None]:
    runners: list[dict[str, Any]] = []

    pkg_json = workdir / "package.json"
    if pkg_json.is_file():
        try:
            pkg = json.loads(pkg_json.read_text(encoding="utf-8"))
        except Exception:
            pkg = {}
        scripts = pkg.get("scripts") if isinstance(pkg, dict) else {}
        has_test_script = isinstance(scripts, dict) and isinstance(scripts.get("test"), str) and "no test specified" not in scripts["test"]
        if (workdir / "bun.lock").is_file() or (workdir / "bun.lockb").is_file():
            if shutil.which("bun"):
                runners.append({"kind": "bun", "command": ["bun", "test"], "available": True})
        if has_test_script:
            if shutil.which("npm"):
                runners.append({"kind": "npm", "command": ["npm", "test", "--", "--watch=false"], "available": True})
            elif shutil.which("bun"):
                runners.append({"kind": "bun-script", "command": ["bun", "run", "test"], "available": True})

    has_python_markers = any(
        (workdir / marker).exists()
        for marker in ("pyproject.toml", "pytest.ini", "setup.cfg", "setup.py", "tests", "test")
    )
    if has_python_markers:
        pytest_ok = subprocess.run(
            [sys.executable, "-c", "import pytest"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode == 0
        if pytest_ok:
            runners.append({"kind": "pytest", "command": [sys.executable, "-m", "pytest", "-q"], "available": True})
        elif shutil.which("pytest"):
            runners.append({"kind": "pytest", "command": ["pytest", "-q"], "available": True})
        unittest_cmd = [sys.executable, "-m", "unittest", "discover"]
        if (workdir / "tests").is_dir():
            unittest_cmd.extend(["-s", "tests", "-t", "."] if (workdir / "tests" / "__init__.py").is_file() else ["-s", "tests"])
        elif (workdir / "test").is_dir():
            unittest_cmd.extend(["-s", "test", "-t", "."] if (workdir / "test" / "__init__.py").is_file() else ["-s", "test"])
        runners.append(
            {
                "kind": "unittest",
                "command": unittest_cmd,
                "available": True,
            }
        )

    if (workdir / "go.mod").is_file():
        runners.append({"kind": "go", "command": ["go", "test", "./..."], "available": bool(shutil.which("go"))})

    if (workdir / "Cargo.toml").is_file():
        runners.append({"kind": "cargo", "command": ["cargo", "test"], "available": bool(shutil.which("cargo"))})

    recommended = next((r["command"] for r in runners if r.get("available")), None)
    return runners, recommended


def cmd_detect_tests(args: argparse.Namespace) -> None:
    workdir = resolve_workdir(args.dir)
    if not workdir.is_dir():
        emit({"ok": False, "error": f"Directory does not exist: {workdir}"}, 1)
    runners, recommended = detect_runners(workdir)
    emit(
        {
            "ok": True,
            "dir": str(workdir),
            "runners": runners,
            "recommended": recommended,
        }
    )


def cmd_run_tests(args: argparse.Namespace) -> None:
    workdir = resolve_workdir(args.dir)
    if not workdir.is_dir():
        emit({"ok": False, "error": f"Directory does not exist: {workdir}"}, 1)

    timeout_sec = max(5, min(int(args.timeout), 300))
    runners, recommended = detect_runners(workdir)
    if not recommended:
        emit(
            {
                "ok": False,
                "dir": str(workdir),
                "runners": runners,
                "error": "No supported test runner detected in repository.",
            },
            0,
        )

    code, out, err, elapsed_ms = run_cmd(recommended, cwd=workdir, timeout_sec=timeout_sec)
    emit(
        {
            "ok": code == 0,
            "dir": str(workdir),
            "command": recommended,
            "exit_code": code,
            "duration_ms": elapsed_ms,
            "stdout": clip(out),
            "stderr": clip(err),
        }
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Sandboxed GitHub PR checkout and test helper")
    sub = parser.add_subparsers(dest="subcommand", required=True)

    p_clone = sub.add_parser("clone-pr", help="Shallow-fetch and checkout a GitHub PR head into /workspace")
    p_clone.add_argument("--repo", required=True, help="GitHub owner/repo (for example octocat/Hello-World)")
    p_clone.add_argument("--pr", required=True, type=int, help="Pull request number")
    p_clone.add_argument("--dir", default="/workspace/pr", help="Target directory inside /workspace")
    p_clone.set_defaults(func=cmd_clone_pr)

    p_detect = sub.add_parser("detect-tests", help="Detect available test runners in a checked-out directory")
    p_detect.add_argument("--dir", default="/workspace/pr", help="Checked-out PR directory inside /workspace")
    p_detect.set_defaults(func=cmd_detect_tests)

    p_run = sub.add_parser("run-tests", help="Execute detected test runner with bounded timeout and output")
    p_run.add_argument("--dir", default="/workspace/pr", help="Checked-out PR directory inside /workspace")
    p_run.add_argument("--timeout", default=90, type=int, help="Timeout in seconds (5..300)")
    p_run.set_defaults(func=cmd_run_tests)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
