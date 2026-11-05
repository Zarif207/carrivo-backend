export type DatabaseState = "up" | "down";

export interface HealthStatus {
  status: "ok";
  environment: string;
  uptime: number;
  timestamp: string;
  database: DatabaseState;
}
