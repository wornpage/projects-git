// A committed file must have the same identity on all supported host filesystems.
export function portablePath(value) {
  return typeof value === 'string' && value.length <= 500 && value.split('/').every(part => part && part !== '.' && part !== '..'
    && !/[\\\x00-\x1f\x7f:*?"<>|]/.test(part) && part.trim() === part && !part.endsWith('.')
    && !/^\.git$/i.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
