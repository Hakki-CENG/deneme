#!/usr/bin/env python3
"""Persistent HAF Python kernel JSONL bridge.

Protocol output always uses sys.__stdout__. User stdout/stderr is captured inside
execute responses so model-generated print() calls cannot corrupt framing.
This process is a lifecycle boundary, not a security sandbox; production must
run it inside the configured sandbox fabric.
"""
from __future__ import annotations

import ast
import contextlib
import io
import json
import os
import sys
import traceback
import uuid
from pathlib import Path
from typing import Any

_PROTOCOL_OUT = sys.__stdout__
_PROTOCOL_IN = sys.__stdin__


def send(value: dict[str, Any]) -> None:
    _PROTOCOL_OUT.write(json.dumps(value, ensure_ascii=False, default=str) + "\n")
    _PROTOCOL_OUT.flush()


class HostBridge:
    def __init__(self) -> None:
        self._execution_id: str | None = None
        self._kernel_generation: str | None = None
        self._host_token: str | None = None

    def _begin(self, execution_id: str, kernel_generation: str, host_token: str) -> None:
        self._execution_id = execution_id
        self._kernel_generation = kernel_generation
        self._host_token = host_token

    def _end(self) -> None:
        self._execution_id = None
        self._kernel_generation = None
        self._host_token = None

    def call(self, capability: str, arguments: dict[str, Any] | None = None) -> Any:
        if not self._execution_id or not self._kernel_generation or not self._host_token:
            raise RuntimeError("host capability calls are allowed only during a current execution")
        request_id = str(uuid.uuid4())
        send({
            "type": "host_request",
            "requestId": request_id,
            "executionId": self._execution_id,
            "kernelGeneration": self._kernel_generation,
            "hostToken": self._host_token,
            "capability": capability,
            "arguments": arguments or {},
        })
        while True:
            line = _PROTOCOL_IN.readline()
            if not line:
                raise RuntimeError("host disconnected while a capability call was pending")
            response = json.loads(line)
            if (
                response.get("type") != "host_response"
                or response.get("requestId") != request_id
                or response.get("executionId") != self._execution_id
                or response.get("kernelGeneration") != self._kernel_generation
            ):
                raise RuntimeError("unexpected or stale frame while waiting for host response")
            if response.get("ok"):
                return response.get("result")
            raise RuntimeError(response.get("error") or "host capability failed")


haf = HostBridge()
namespace: dict[str, Any] = {
    "__name__": "__haf_kernel__",
    "__builtins__": __builtins__,
    "haf": haf,
    "Path": Path,
}


def json_safe(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        raise TypeError("maximum snapshot depth exceeded")
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [json_safe(item, depth + 1) for item in value]
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        return {key: json_safe(item, depth + 1) for key, item in value.items()}
    raise TypeError(f"unsupported snapshot value: {type(value).__name__}")


def execute(code: str) -> dict[str, Any]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    result: Any = None
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        tree = ast.parse(code, mode="exec")
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            expression = ast.Expression(tree.body.pop().value)
            if tree.body:
                exec(compile(tree, "<haf-kernel>", "exec"), namespace, namespace)
            result = eval(compile(expression, "<haf-kernel>", "eval"), namespace, namespace)
        else:
            exec(compile(tree, "<haf-kernel>", "exec"), namespace, namespace)
    return {
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "result": repr(result) if result is not None else None,
        "resultType": type(result).__name__ if result is not None else None,
    }


def snapshot(path: str) -> dict[str, Any]:
    values: dict[str, Any] = {}
    skipped: dict[str, str] = {}
    for key, value in namespace.items():
        if key.startswith("_") or key in {"haf", "Path"}:
            continue
        try:
            values[key] = json_safe(value)
        except TypeError as exc:
            skipped[key] = str(exc)
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps({"version": 1, "values": values}, indent=2), encoding="utf-8")
    os.replace(temporary, target)
    return {"saved": sorted(values), "skipped": skipped}


def restore(path: str) -> dict[str, Any]:
    target = Path(path)
    if not target.exists():
        return {"restored": []}
    data = json.loads(target.read_text(encoding="utf-8"))
    values = data.get("values", {})
    if not isinstance(values, dict):
        raise ValueError("invalid kernel snapshot")
    namespace.update(values)
    return {"restored": sorted(values)}


def main() -> None:
    send({"type": "ready", "pid": os.getpid(), "protocolVersion": 2})
    for raw in _PROTOCOL_IN:
        execution_id: str | None = None
        try:
            frame = json.loads(raw)
            frame_type = frame.get("type")
            frame_id = frame.get("id")
            if frame_type == "execute":
                execution_id = frame.get("executionId")
                kernel_generation = frame.get("kernelGeneration")
                host_token = frame.get("hostToken")
                if not all(isinstance(value, str) and value for value in (execution_id, kernel_generation, host_token)):
                    raise ValueError("execute frame omitted generation-fencing metadata")
                haf._begin(execution_id, kernel_generation, host_token)
                try:
                    outcome = execute(str(frame.get("code", "")))
                finally:
                    haf._end()
                send({"type": "result", "id": frame_id, "executionId": execution_id, "ok": True, **outcome})
            elif frame_type == "snapshot":
                send({"type": "result", "id": frame_id, "ok": True, "result": snapshot(str(frame["path"]))})
            elif frame_type == "restore":
                send({"type": "result", "id": frame_id, "ok": True, "result": restore(str(frame["path"]))})
            elif frame_type == "shutdown":
                send({"type": "result", "id": frame_id, "ok": True, "result": "bye"})
                return
            else:
                raise ValueError(f"unknown frame type: {frame_type}")
        except BaseException as exc:
            send({
                "type": "result",
                "id": locals().get("frame_id"),
                "executionId": execution_id,
                "ok": False,
                "error": str(exc),
                "traceback": traceback.format_exc(limit=12),
            })


if __name__ == "__main__":
    main()
