"""Pure version/serialization contract, safe in API and imaging interpreters."""

import json

ALGORITHM_VERSION = "phase2-native-numerics-v1"
KINDS = ("rod-deployment", "stokes-flow", "centerline")


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)
