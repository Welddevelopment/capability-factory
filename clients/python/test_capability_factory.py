import json
import unittest

from capability_factory import CapabilityFactoryClient, CapabilityFactoryError


class Response:
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def read(self, _limit): return json.dumps(self.value).encode()


class QueueOpener:
    def __init__(self, values): self.values = list(values); self.requests = []
    def __call__(self, request, timeout):
        self.requests.append((request, timeout))
        return Response(self.values.pop(0))


class ClientTests(unittest.TestCase):
    def test_rejects_remote_and_credentialed_urls(self):
        for url in ("https://127.0.0.1:4317", "http://example.com", "http://user:pass@localhost:4317", "http://localhost:4317/path"):
            with self.assertRaises(ValueError): CapabilityFactoryClient(url, "x" * 32)

    def test_submits_with_token_header_and_validates_receipt(self):
        receipt = {"schemaVersion": "1.0", "jobId": "a" * 32, "status": "queued"}
        opener = QueueOpener([receipt])
        client = CapabilityFactoryClient("http://127.0.0.1:4317", "t" * 32, opener=opener)
        self.assertEqual(client.start_goal({"schemaVersion": "1.0"}), receipt)
        self.assertEqual(opener.requests[0][0].get_header("X-capability-sidecar-token"), "t" * 32)

    def test_rejects_invalid_receipt(self):
        client = CapabilityFactoryClient("http://localhost:4317", "t" * 32, opener=QueueOpener([{"status": "done"}]))
        with self.assertRaises(CapabilityFactoryError): client.start_goal({})


if __name__ == "__main__": unittest.main()
