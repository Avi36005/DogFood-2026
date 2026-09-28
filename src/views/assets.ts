const versions = new Map<string, string>();

export function registerAsset(name: string, hash: string): void {
  versions.set(name, hash);
}

/** /static/app.css?v=<content hash>, so a new release is never hidden behind a cached file. */
export function asset(name: string): string {
  const version = versions.get(name);
  return version ? `/static/${name}?v=${version}` : `/static/${name}`;
}
