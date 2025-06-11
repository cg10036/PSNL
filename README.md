# PSNL: Proxmox Scheduled Network Limiter

PSNL (Proxmox Scheduled Network Limiter) is a Node.js application designed to manage network bandwidth for Proxmox VE (PVE) LXC containers and/or Virtual Machines (VMs) based on a defined schedule.

The primary goal is to allow bandwidth-intensive tasks to run with higher (or unlimited) bandwidth during off-peak hours (e.g., at night) and automatically throttle their network usage during peak hours (e.g., daytime) to ensure fair network access for other users or services.

This tool connects to the Proxmox VE API to dynamically adjust network rate limits on specified guests according to the schedule you define in `config.json`.

## Features

*   Schedule-based network rate limiting for PVE guests (LXC/VM) across multiple Proxmox servers and nodes.
*   Flexible scheduling using time-based rules (HH:MM format).
*   Define different rate limits for different times of day for each network interface of a guest.
*   Configuration via a `config.json` file, supporting multiple Proxmox servers.
*   Written in TypeScript for better maintainability.
*   Uses a specified timezone for accurate scheduling.

## Prerequisites

*   Node.js (v22.x or newer recommended)
*   npm (usually comes with Node.js)
*   Access to your Proxmox VE server(s) with API credentials.
*   The target LXC/VMs must have network interfaces that support rate limiting (e.g., `virtio` for VMs, typically `eth0` or `net0` for LXCs).

## How to Run

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/cg10036/PSNL.git
    cd PSNL
    ```

2.  **Install dependencies:**
    ```bash
    npm i
    ```

3.  **Configure the application:**
    *   Copy the example configuration file:
        ```bash
        cp config.json.example config.json
        ```
    *   Edit `config.json` with your Proxmox API details, target guest IDs, schedule, and bandwidth limits:
        ```bash
        vim config.json # Or your preferred text editor
        ```
        The `config.json` structure is as follows:

        ```json
        {
          "timezone": "Asia/Seoul", // Timezone for scheduling (e.g., "America/New_York", "Europe/London")
          "servers": {
            "https://your-proxmox-host1.example.com:8006": { // Full URL of your Proxmox server
              "id": "root@pam!your_api_token_id",      // API User ID (e.g., user@realm!tokenId)
              "secret": "your_api_token_secret_value", // API Token Secret or user password (API Token strongly recommended)
              "nodes": {
                "your-proxmox-node1-name": [          // Name of the Proxmox node
                  {
                    "type": "lxc",                    // "lxc" for LXC containers, "qemu" for VMs
                    "id": 106,                        // Guest ID (integer)
                    "sched": {                        // Schedule object
                      "23:00": {                      // Time (HH:MM, 24-hour format)
                        "net0": 0                     // Interface: rate in MB/s (0 means unlimited)
                      },
                      "07:00": {
                        "net0": 7                     // Limit net0 to 7 MB/s at 07:00
                      }
                      // You can add more time entries and interfaces
                      // e.g., "10:00": { "net0": 5, "net1": 10 }
                    }
                  },
                  {
                    "type": "qemu",                   // Example for a VM
                    "id": 107,
                    "sched": {
                      "22:00": { "net0": 0 },
                      "08:00": { "net0": 10 }
                    }
                  }
                  // Add more guests for this node if needed
                ]
                // Add more nodes for this server if needed
              }
            }
            // Add more Proxmox servers if needed
          }
        }
        ```
        **Key configuration points:**
        *   `timezone`: Crucial for ensuring schedules are triggered at the correct local time. Find valid timezone strings [here](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones).
        *   `servers`: An object where each key is the full URL to your Proxmox server's API.
        *   `id` & `secret`: Your Proxmox API credentials.
        *   `nodes`: Under each server, an object where each key is the name of a Proxmox node.
        *   Each node contains an array of guest objects.
            *   `type`: Set to `"lxc"` for LXC containers or `"qemu"` for Virtual Machines (VMs).
            *   `id`: The numerical ID of the LXC container or VM.
            *   `sched`: This object defines the schedule.
                *   Keys are times in `"HH:MM"` format (24-hour clock, based on the `timezone`).
                *   Values are objects where keys are network interface names (e.g., `"net0"`, `"net1"`) and values are the desired rate limit in **MB/s**. A rate of `0` typically means unlimited bandwidth (Proxmox API behavior).

4.  **Compile TypeScript to JavaScript:**
    ```bash
    npx tsc
    ```
    This will create a `dist` directory (or as configured in `tsconfig.json`) with the compiled JavaScript files.

5.  **Run the application:**
    ```bash
    node dist/index.js # Adjust if your main compiled file has a different name or path
    ```
    For continuous operation, consider running PSNL with a process manager like `pm2` or setting it up as a `systemd` service.

## How it Works

1.  **Initialization**: The application loads the configuration from `config.json`, including the `timezone`, server details, and schedules.
2.  **Periodic Checks**: The script periodically checks the current time (respecting the configured `timezone`).
3.  **Schedule Evaluation**: For each guest defined in the configuration:
    *   It determines the active schedule by finding the latest past time entry in the guest's `sched` object relative to the current time. For example, if the current time is 08:00 (and `timezone` is correctly set), and schedules are defined for "07:00" and "23:00", the rules set for "07:00" will be considered active.
4.  **API Interaction**:
    *   It connects to the relevant Proxmox server using the provided API credentials.
    *   Based on the guest `type` (`"lxc"` or `"qemu"`), it constructs the correct API endpoint.
    *   It then applies the network rate limits (e.g., `rate=X` in MB/s, where `0` means unlimited) to the specified network interfaces (e.g., `net0`) of the target guest via the Proxmox API.
5.  **Continuous Monitoring**: The script continues this process, re-evaluating and applying the correct network limits as time progresses and new schedule points are reached.
