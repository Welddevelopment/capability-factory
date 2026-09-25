"""Dependency-free Python client for the customer-hosted Capability Factory sidecar."""

from __future__ import annotations

import json
import time
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


class CapabilityFactoryError(RuntimeError):
    pass


class CapabilityFactoryClient:
    """Submits ordinary goals to a localhost sidecar; it never receives customer credentials."""

    def __init__(self, base_url: str, access_token: str, timeout_seconds: float = 30, max_response_bytes: int = 1_000_000, opener: Callable[..., Any] = urlopen):
        parsed = urlparse(base_url)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.username or parsed.password or parsed.path not in ("", "/"):
            raise ValueError("The reference client accepts a localhost HTTP origin without credentials or a path")
        if len(access_token) < 16:
            raise ValueError("Sidecar access token must contain at least 16 characters")
        if timeout_seconds <= 0 or max_response_bytes < 1:
            raise ValueError("Timeout and response limit must be positive")
        self._base_url = base_url.rstrip("/")
        self._access_token = access_token
        self._timeout = timeout_seconds
        self._max_response_bytes = max_response_bytes
        self._opener = opener

    def start_goal(self, request: dict[str, Any]) -> dict[str, Any]:
        return self._receipt(self._request("POST", "/v1/goal-jobs", request))

    def get_goal_job(self, tenant_id: str, job_id: str) -> dict[str, Any]:
        query = urlencode({"tenantId": tenant_id})
        return self._receipt(self._request("GET", f"/v1/goal-jobs/{job_id}?{query}"))

    def get_goal_job_events(self, tenant_id: str, job_id: str, after_sequence: int = 0) -> list[dict[str, Any]]:
        if not isinstance(after_sequence, int) or after_sequence < 0:
            raise ValueError("Event cursor must be a non-negative integer")
        query = urlencode({"tenantId": tenant_id, "after": after_sequence})
        value = self._request("GET", f"/v1/goal-jobs/{job_id}/events?{query}")
        events = value.get("events") if isinstance(value, dict) else None
        if not isinstance(events, list) or not all(self._valid_event(item) for item in events):
            raise CapabilityFactoryError("Sidecar returned an invalid goal-job event page")
        return events

    def continue_goal_job(self, tenant_id: str, job_id: str, grant: dict[str, Any]) -> dict[str, Any]:
        return self._receipt(self._request("POST", f"/v1/goal-jobs/{job_id}/continue", {"tenantId": tenant_id, "grant": grant}))

    def wait_for_goal_job(self, tenant_id: str, job_id: str, timeout_seconds: float = 300, poll_interval_seconds: float = 0.25, on_status: Callable[[dict[str, Any]], None] | None = None, on_event: Callable[[dict[str, Any]], None] | None = None) -> dict[str, Any]:
        if timeout_seconds <= 0 or not 0.01 <= poll_interval_seconds <= 10:
            raise ValueError("Wait timeout must be positive and polling must be between 0.01 and 10 seconds")
        deadline = time.monotonic() + timeout_seconds
        cursor = 0
        previous_status: str | None = None
        while True:
            for event in self.get_goal_job_events(tenant_id, job_id, cursor):
                if event["sequence"] <= cursor:
                    raise CapabilityFactoryError("Sidecar event sequence did not advance monotonically")
                cursor = event["sequence"]
                if on_event:
                    on_event(event)
            job = self.get_goal_job(tenant_id, job_id)
            if job["status"] != previous_status:
                previous_status = job["status"]
                if on_status:
                    on_status(job)
            if job["status"] not in ("queued", "running"):
                return job
            if time.monotonic() >= deadline:
                raise TimeoutError("Timed out waiting for the sidecar goal job")
            time.sleep(min(poll_interval_seconds, max(0, deadline - time.monotonic())))

    def _request(self, method: str, route: str, body: Any | None = None) -> Any:
        encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers = {"Accept": "application/json", "X-Capability-Sidecar-Token": self._access_token}
        if encoded is not None:
            headers["Content-Type"] = "application/json"
        request = Request(f"{self._base_url}{route}", data=encoded, headers=headers, method=method)
        try:
            with self._opener(request, timeout=self._timeout) as response:
                raw = response.read(self._max_response_bytes + 1)
        except HTTPError as error:
            raise CapabilityFactoryError(f"Sidecar request failed with HTTP {error.code}") from error
        if len(raw) > self._max_response_bytes:
            raise CapabilityFactoryError("Sidecar response exceeded the configured size limit")
        try:
            return json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CapabilityFactoryError("Sidecar returned invalid JSON") from error

    @staticmethod
    def _receipt(value: Any) -> dict[str, Any]:
        if not isinstance(value, dict) or value.get("schemaVersion") != "1.0" or not isinstance(value.get("jobId"), str) or value.get("status") not in {"queued", "running", "completed", "partially-complete", "blocked", "failed", "unknown", "handoff", "plan-rejected"}:
            raise CapabilityFactoryError("Sidecar returned an invalid goal-job receipt")
        return value

    @staticmethod
    def _valid_event(value: Any) -> bool:
        return isinstance(value, dict) and isinstance(value.get("sequence"), int) and isinstance(value.get("jobId"), str) and isinstance(value.get("status"), str) and isinstance(value.get("type"), str)

