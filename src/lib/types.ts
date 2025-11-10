// shared types between all components

export interface NodeResources {
  cpu: {
    cores: number;
    available: number;
  };
  memory: {
    total: number;  // gb
    available: number;
  };
  disk: Array<{
    path: string;
    total?: number;     // gb
    available: number;  // gb
  }>;
  network: {
    bandwidth: number; // mbps
  };
}

export interface JobSpec {
  id: string;
  userId: string;
  image: string;
  resources: {
    cpu: number;    // cores
    memory: number; // gb
    disk?: number;  // gb
  };
  env?: Record<string, string>;
  duration?: number; // seconds, 0 = unlimited
  price?: number;    // per hour
}

export interface NodeAnnouncement {
  nodeId: string;
  peerId?: string;  // p2p network peer id
  resources: NodeResources;
  location?: {
    country: string;
    region: string;
  };
  price?: {
    cpu: number;    // per core per hour
    memory: number; // per gb per hour
    storage: number; // per gb per hour
  };
  timestamp?: number;
  version: string;
}
