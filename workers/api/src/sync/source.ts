// The scanner reads a repository through this interface, so the same extraction code can run over a
// local checkout today and over fetched GitHub content later, with no filesystem dependency.
export interface RepoSource {
  /** Every file path in the repository, relative to its root, using forward slashes. */
  paths: string[];
  /** Returns UTF-8 text, or throws when the file cannot be read. */
  read(path: string): string;
}

// Manifest globs only use a star inside a single path segment, e.g. services/<star>/service.yaml.
export function globPaths(paths: string[], pattern: string): string[] {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+');
  const re = new RegExp(`^${source}$`);
  return paths.filter((p) => re.test(p)).sort();
}
