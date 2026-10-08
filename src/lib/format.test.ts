import { describe, expect, it } from 'vitest';

function filterEnvironments<T extends { name: string | null; prefix: string }>(items: T[], query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter((item) => `${item.name ?? ''} ${item.prefix}`.toLocaleLowerCase().includes(normalized));
}

describe('environment search', () => {
  const environments = [
    { name: 'base', prefix: 'D:\\Conda' },
    { name: 'vision-lab', prefix: 'E:\\Envs\\vision-lab' },
    { name: null, prefix: 'C:\\Users\\dev\\envs\\unnamed' },
  ];

  it('matches environment names case-insensitively', () => {
    expect(filterEnvironments(environments, 'VISION')).toHaveLength(1);
  });

  it('matches a prefix even when the environment has no name', () => {
    expect(filterEnvironments(environments, 'unnamed')[0]?.name).toBeNull();
  });

  it('returns all environments for an empty query', () => {
    expect(filterEnvironments(environments, ' ')).toHaveLength(3);
  });
});
