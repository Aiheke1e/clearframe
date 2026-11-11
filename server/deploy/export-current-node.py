"""Export only the active Clash node to a private server config. Never print credentials."""
import hashlib
import json
import pathlib
import sys
import urllib.request
import yaml


def main():
    source, destination = map(pathlib.Path, sys.argv[1:3])
    config = yaml.safe_load(source.read_text(encoding="utf-8"))
    controller = str(config.get("external-controller", ""))
    if not controller.startswith("127.0.0.1:"):
        raise RuntimeError("Expected loopback controller")
    headers = {}
    if config.get("secret"):
        headers["Authorization"] = "Bearer " + str(config["secret"])
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request("http://" + controller + "/proxies", headers=headers)
    with opener.open(request, timeout=10) as response:
        proxies = json.load(response)["proxies"]
    selected = "GLOBAL"
    visited = set()
    while proxies.get(selected, {}).get("now"):
        if selected in visited:
            raise RuntimeError("Cyclic proxy selection")
        visited.add(selected)
        selected = proxies[selected]["now"]
    nodes = {node["name"]: node for node in config.get("proxies", [])}
    if selected not in nodes:
        raise RuntimeError("Active selection is not an exportable node")
    node = dict(nodes[selected])
    if node.get("dialer-proxy"):
        raise RuntimeError("Active node needs a separate relay; export requires dependency review")
    for key in ("ca", "certificate", "private-key"):
        value = node.get(key)
        if value and pathlib.Path(str(value)).is_file():
            raise RuntimeError("Active node refers to a local certificate file")
    node["name"] = "SERVER-NODE"
    output = {
        "mixed-port": 7897, "allow-lan": False, "bind-address": "127.0.0.1",
        "mode": "rule", "log-level": "warning", "ipv6": False,
        "external-controller": "", "tun": {"enable": False}, "dns": {"enable": False},
        "proxies": [node],
        "proxy-groups": [{"name": "X-EXIT", "type": "select", "proxies": ["SERVER-NODE"]}],
        "rules": ["MATCH,X-EXIT"],
    }
    destination.write_text(yaml.safe_dump(output, allow_unicode=True, sort_keys=False), encoding="utf-8")
    print(json.dumps({"exportedNodes": 1, "type": node.get("type"), "fingerprint": hashlib.sha256(selected.encode()).hexdigest()[:12]}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # YAML/parser/network errors may embed private configuration, so suppress their details.
        print(json.dumps({"exportedNodes": 0, "errorType": type(error).__name__}), file=sys.stderr)
        sys.exit(1)
