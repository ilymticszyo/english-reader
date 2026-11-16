export interface Route {
  name: 'list' | 'read' | 'words' | 'settings' | 'about';
  id?: string;
  query: URLSearchParams;
}
export function parseHash(hash = location.hash): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const query = new URLSearchParams(qs);
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'read' && parts[1]) return { name: 'read', id: decodeURIComponent(parts[1]), query };
  if (parts[0] === 'words') return { name: 'words', query };
  if (parts[0] === 'about') return { name: 'about', query };
  if (parts[0] === 'settings') return { name: 'settings', query };
  return { name: 'list', query };
}
export const go = (path: string) => {
  location.hash = path;
};
