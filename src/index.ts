import fetch from "node-fetch";
import fs from "fs";
import cron from "node-cron";

// ===== 타입 정의 =====
interface NetworkInterface {
  [key: string]: string;
}

interface NetworkConfig {
  [interfaceName: string]: number;
}

interface Schedule {
  [time: string]: NetworkConfig;
}

interface Node {
  type: string;
  id: number;
  sched: Schedule;
}

interface ServerConfig {
  id: string;
  secret: string;
  nodes: {
    [nodeName: string]: Node[];
  };
}

interface Config {
  timezone: string;
  servers: {
    [serverUrl: string]: ServerConfig;
  };
}

// ===== 설정 로딩 =====
function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync("config.json", "utf-8"));
  } catch (error) {
    console.error("Failed to load config.json:", error);
    process.exit(1);
  }
}

// ===== 로깅 유틸리티 =====
class Logger {
  static info(message: string) {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
  }

  static error(message: string, error?: unknown) {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, error);
  }

  static success(message: string) {
    console.log(`[SUCCESS] ${new Date().toISOString()} - ${message}`);
  }
}

// ===== API 클라이언트 =====
class ProxmoxClient {
  constructor(
    private host: string,
    private apiId: string,
    private apiSecret: string
  ) {}

  private get headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `PVEAPIToken=${this.apiId}=${this.apiSecret}`,
    };
  }

  private getConfigUrl(nodeName: string, type: string, vmId: number): string {
    return `${this.host}/api2/json/nodes/${nodeName}/${type}/${vmId}/config`;
  }

  async getCurrentConfig(
    nodeName: string,
    type: string,
    vmId: number
  ): Promise<any> {
    const url = this.getConfigUrl(nodeName, type, vmId);
    const response = await fetch(url, {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      throw new Error(
        `Failed to get config: ${response.status} ${response.statusText}`
      );
    }

    const { data } = await response.json();
    return data;
  }

  async updateConfig(
    nodeName: string,
    type: string,
    vmId: number,
    config: object
  ): Promise<boolean> {
    const url = this.getConfigUrl(nodeName, type, vmId);
    const response = await fetch(url, {
      method: "PUT",
      headers: this.headers,
      body: JSON.stringify(config),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to update config: ${response.status} ${response.statusText}`
      );
    }

    const { data } = await response.json();
    return data === null;
  }
}

// ===== 네트워크 인터페이스 관리 =====
class NetworkManager {
  static parseNetworkInterface(interfaceString: string): NetworkInterface {
    const net: NetworkInterface = {};
    interfaceString.split(",").forEach((item: string) => {
      const [key, value] = item.split("=");
      if (key && value !== undefined) {
        net[key] = value;
      }
    });
    return net;
  }

  static buildNetworkInterface(net: NetworkInterface): string {
    return Object.entries(net)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
  }

  static updateInterfaceRate(
    net: NetworkInterface,
    rate: number
  ): NetworkInterface {
    const updatedNet = { ...net };

    if (!rate) {
      delete updatedNet["rate"];
    } else {
      updatedNet["rate"] = rate.toString();
    }

    return updatedNet;
  }
}

// ===== 스케줄러 관리 =====
class ScheduleManager {
  constructor(private timezone: string) {}

  async setNetworkInterface(
    client: ProxmoxClient,
    nodeName: string,
    type: string,
    vmId: number,
    interfaceName: string,
    interfaceValue: number
  ): Promise<boolean> {
    try {
      // 현재 설정 가져오기
      const currentConfig = await client.getCurrentConfig(nodeName, type, vmId);

      if (!currentConfig[interfaceName]) {
        throw new Error(`Interface ${interfaceName} not found in VM config`);
      }

      // 네트워크 인터페이스 파싱 및 업데이트
      const currentNet = NetworkManager.parseNetworkInterface(
        currentConfig[interfaceName]
      );
      const updatedNet = NetworkManager.updateInterfaceRate(
        currentNet,
        interfaceValue
      );

      // 설정 업데이트
      const newConfig = {
        [interfaceName]: NetworkManager.buildNetworkInterface(updatedNet),
      };

      return await client.updateConfig(nodeName, type, vmId, newConfig);
    } catch (error) {
      Logger.error(
        `Failed to set interface ${interfaceName} for ${nodeName}/${type}/${vmId}`,
        error
      );
      return false;
    }
  }

  scheduleNetworkUpdate(
    client: ProxmoxClient,
    nodeName: string,
    node: Node,
    time: string,
    interfaceName: string,
    interfaceValue: number
  ): void {
    const [hour, minute] = time.split(":");
    const cronExpression = `${minute} ${hour} * * *`;

    cron.schedule(
      cronExpression,
      async () => {
        Logger.info(
          `Executing scheduled task: ${nodeName}/${node.type}/${node.id} ${interfaceName}=${interfaceValue}`
        );

        const success = await this.setNetworkInterface(
          client,
          nodeName,
          node.type,
          node.id,
          interfaceName,
          interfaceValue
        );

        if (success) {
          Logger.success(
            `${nodeName}/${node.type}/${node.id} ${interfaceName}=${interfaceValue} - Applied successfully`
          );
        } else {
          Logger.error(
            `${nodeName}/${node.type}/${node.id} ${interfaceName}=${interfaceValue} - Failed to apply`
          );
        }
      },
      { timezone: this.timezone }
    );

    Logger.info(
      `Scheduled ${time}: ${nodeName}/${node.type}/${node.id} ${interfaceName}=${interfaceValue}`
    );
  }
}

// ===== 메인 애플리케이션 =====
class Application {
  private config: Config;
  private scheduleManager: ScheduleManager;

  constructor() {
    this.config = loadConfig();
    this.scheduleManager = new ScheduleManager(this.config.timezone);
  }

  start(): void {
    Logger.info("Starting PSNL (Proxmox Scheduler Network Limiter)");
    Logger.info(`Timezone: ${this.config.timezone}`);

    for (const [serverUrl, serverConfig] of Object.entries(
      this.config.servers
    )) {
      this.setupServerSchedules(serverUrl, serverConfig);
    }

    Logger.info("All schedules have been set up successfully");
  }

  private setupServerSchedules(
    serverUrl: string,
    serverConfig: ServerConfig
  ): void {
    const client = new ProxmoxClient(
      serverUrl,
      serverConfig.id,
      serverConfig.secret
    );

    Logger.info(`Setting up schedules for server: ${serverUrl}`);

    for (const [nodeName, nodes] of Object.entries(serverConfig.nodes)) {
      for (const node of nodes) {
        this.setupNodeSchedules(client, nodeName, node);
      }
    }
  }

  private setupNodeSchedules(
    client: ProxmoxClient,
    nodeName: string,
    node: Node
  ): void {
    for (const [time, interfaces] of Object.entries(node.sched)) {
      for (const [interfaceName, interfaceValue] of Object.entries(
        interfaces
      )) {
        this.scheduleManager.scheduleNetworkUpdate(
          client,
          nodeName,
          node,
          time,
          interfaceName,
          interfaceValue
        );
      }
    }
  }
}

// ===== 애플리케이션 시작 =====
const app = new Application();
app.start();
