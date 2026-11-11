export interface ApiInfo {
  name: string;
  version: string;
  status: "ok";
  environment: "production" | "development";
  docs: string;
  health: string;
  endpoints: {
    auth: string;
    users: string;
    shipments: string;
    payments: string;
    zones: string;
    hubs: string;
    pricing: string;
    notifications: string;
    courierApplications: string;
    tracking: string;
    admin: string;
  };
  timestamp: string;
}
