export interface ServiceRegistry {

  register<T>(name: string, service: T): void;
  get<T>(name: string): T | undefined;
  has(name: string): boolean;

  names(): readonly string[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function createServiceRegistry(): ServiceRegistry {
  const services = new Map<string, unknown>();
  return {
    register<T>(name: string, service: T): void {
      if (!NAME_PATTERN.test(name)) {
        throw new Error(`服务名不合法：${JSON.stringify(name)}（应为小写字母开头，可含 . _ - 与数字）`);
      }
      if (services.has(name)) {
        throw new Error(`服务名重复注册：${name}`);
      }
      services.set(name, service);
    },
    get<T>(name: string): T | undefined {
      return services.get(name) as T | undefined;
    },
    has(name: string): boolean {
      return services.has(name);
    },
    names(): readonly string[] {
      return [...services.keys()];
    },
  };
}
