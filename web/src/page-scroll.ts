export const pageScroller = () => {
  const main = document.querySelector(".app-shell > main");
  return main instanceof HTMLElement && getComputedStyle(main).overflowY === "auto" ? main : null;
};
export const pageScrollTop = () => pageScroller()?.scrollTop ?? window.scrollY;
export const scrollPageTo = (top: number) => {
  const main = pageScroller();
  if (main) main.scrollTo(0, top); else window.scrollTo(0, top);
};
export const pageNearBottom = (margin: number) => {
  const main = pageScroller();
  return main ? main.scrollTop + main.clientHeight >= main.scrollHeight - margin
    : window.scrollY + window.innerHeight >= document.body.offsetHeight - margin;
};
