// One browser JSON download path. Bounded archives must retain their admitted compact encoding.
export function downloadJson(data, filename, {compact = false} = {}) {
  const text = compact ? JSON.stringify(data) : JSON.stringify(data, null, 2) + '\n';
  const url = URL.createObjectURL(new Blob([text], {type:'application/json;charset=utf-8'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
