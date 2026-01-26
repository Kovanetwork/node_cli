# Kova Node

Provider node software for the Kova decentralized compute network. Share your spare computing resources and earn rewards.

## Overview

Kova is a decentralized marketplace for compute resources. By running this node software, you contribute idle computing power to the network and receive compensation for workloads executed on your machine.

The platform enables anyone to become a compute provider, creating a distributed alternative to traditional cloud infrastructure.

## Requirements

- Docker (latest stable version)
- Linux or macOS
- Stable internet connection
- Ethereum wallet address

## Installation

Install the node software globally via npm:

```bash
npm install -g @kovanetwork/node-cli
```

Or using yarn:

```bash
yarn global add @kovanetwork/node-cli
```

## Getting Started

### 1. Obtain API Key

Visit https://app.kovanetwork.com and authenticate with your wallet. Navigate to the Provider section to retrieve your API key.

### 2. Start Your Node

Launch the node with your API key:

```bash
kova-node start --api-key sk_live_your_key_here
```

The node will register with the network and begin accepting workloads based on your available resources.

## Configuration

By default, the node allocates all available system resources. You can configure resource limits using command-line flags:

```bash
kova-node start --api-key sk_live_your_key_here \
  --max-cpu 4 \
  --max-memory 8 \
  --max-disk 100
```

### Available Options

- `--max-cpu` - Maximum CPU cores to allocate (default: all available)
- `--max-memory` - Maximum memory in GB (default: 80% of system total)
- `--max-disk` - Maximum disk space in GB (default: 100)
- `--port` - P2P network port (default: 4001)

## Commands

Check node status:

```bash
kova-node status
```

View earnings:

```bash
kova-node earnings
```

Stop the node:

```bash
kova-node stop
```

## Earnings

Providers are compensated based on actual resource consumption. Payment rates are determined by:

- CPU and memory utilization
- Job execution duration
- Network demand and pricing

Earnings are credited to your connected wallet address. View accumulated earnings through the dashboard at https://app.kovanetwork.com or via the CLI.

## Security

Workloads execute within isolated Docker containers, providing process and filesystem separation from the host system. However, providers should understand the following:

- Containers provide isolation but are not a complete security boundary
- Providers have visibility into container contents and execution
- Only run nodes on dedicated hardware or machines you control
- Review the security documentation before accepting production workloads

## Troubleshooting

### Docker Not Found

Ensure Docker is installed and the daemon is running. Verify with:

```bash
docker ps
```

### Node Fails to Start

Check if the default port (4001) is available. Specify an alternative if needed:

```bash
kova-node start --api-key sk_live_your_key_here --port 4002
```

### No Jobs Assigned

Network discovery typically takes 10-15 minutes for new nodes. Ensure your node maintains consistent uptime and competitive resource pricing.

### Invalid API Key

If authentication fails, log in to the dashboard and regenerate your API key from the Provider section.

## Support

- Documentation: https://docs.kovanetwork.com
- GitHub Issues: https://github.com/Kovanetwork/node_cli/issues

## License

MIT
