/** 狐友：页面元素选择器。 */
// 支持的桌面圈子信息流选择器。
export const selectors = {
  header: ".app-header__actions",
  avatar: ".app-header__avatar",
  activeTab: ".main-header__tab--active",
  activeCircle: ".main-header__circle--active .main-header__circle-name",
  circleName: ".circle-info-card__name",
  circles: ".main-header__circle-name",
  sort: ".circle-tab__sort",
  category: ".circle-tab__item--active",
  cards: ".feed-list > [data-feed-id] > .feed-card",
  author: ".feed-header__name",
  authorAvatar: ".feed-header__avatar",
  meta: ".feed-header__meta",
  body: ".feed-card__body .feed-rich-text",
  more: ".feed-rich-text__full-text",
  actions: ".feed-footer__actions button",
  images: ".feed-body-image__img",
  pinned: ".pin-bar",
};
