from pathlib import Path

import requests

from lib.core import Config, process_data


def run() -> dict:
    output_dir = Path("/tmp/app-output")
    config = Config(name="main", debug=True, tags=["production", "v1"])
    result = process_data(config)
    response = requests.get("https://httpbin.org/get")
    result["output_dir"] = str(output_dir)
    result["status_code"] = response.status_code
    return result
