// Synthetic source for capture/display qualification, never model-quality proof.
export function reviewScaleFiles() {
  return Object.fromEntries(Array.from({length: 20}, (_, file) => {
    const name = file === 0 ? 'reports/space name.py' : file === 1 ? 'reports/café.py' : `reports/module_${String(file).padStart(2, '0')}.py`;
    const content = Array.from({length: 100}, (_, line) =>
      `value_${String(file).padStart(2, '0')}_${String(line).padStart(3, '0')} = ${file * 100 + line}  # Synthetic capture and review fixture.`.padEnd(76, '.')
    ).join('\n') + '\n';
    return [name, content];
  }));
}
