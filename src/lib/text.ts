/** Strip Vietnamese diacritics and lowercase, so searching "xeo" finds "XÈO". Works on both server and browser. */
export function norm(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase();
}
