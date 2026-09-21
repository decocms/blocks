// AUTO-GENERATED-STYLE manifest — mirrors scripts/generate-manifests.ts output.
// Lists every loader/action module keyed by its CMS resolve path.

import * as actions_cart_addCoupon from "./actions/cart/addCoupon";
import * as actions_cart_addItem from "./actions/cart/addItem";
import * as actions_cart_addItems from "./actions/cart/addItems";
import * as actions_cart_addKit from "./actions/cart/addKit";
import * as actions_cart_partnerAssociate from "./actions/cart/partnerAssociate";
import * as actions_cart_partnerDisassociate from "./actions/cart/partnerDisassociate";
import * as actions_cart_removeCoupon from "./actions/cart/removeCoupon";
import * as actions_cart_removeKit from "./actions/cart/removeKit";
import * as actions_cart_updateItemQuantity from "./actions/cart/updateItemQuantity";
import * as actions_newsletter_register from "./actions/newsletter/register";
import * as actions_notifyme from "./actions/notifyme";
import * as actions_review_create from "./actions/review/create";
import * as actions_shippingSimulation from "./actions/shippingSimulation";
import * as actions_submmitForm from "./actions/submmitForm";
import * as actions_wishlist_addProduct from "./actions/wishlist/addProduct";
import * as actions_wishlist_removeProduct from "./actions/wishlist/removeProduct";
import * as loaders_cart from "./loaders/cart";
import * as loaders_partners from "./loaders/partners";
import * as loaders_productDetailsPage from "./loaders/productDetailsPage";
import * as loaders_productList from "./loaders/productList";
import * as loaders_productListingPage from "./loaders/productListingPage";
import * as loaders_proxy from "./loaders/proxy";
import * as loaders_recommendations from "./loaders/recommendations";
import * as loaders_shop from "./loaders/shop";
import * as loaders_suggestion from "./loaders/suggestion";
import * as loaders_user from "./loaders/user";
import * as loaders_wishlist from "./loaders/wishlist";

const manifest = {
  name: "wake",
  loaders: {
    "wake/loaders/cart": loaders_cart,
    "wake/loaders/partners": loaders_partners,
    "wake/loaders/productDetailsPage": loaders_productDetailsPage,
    "wake/loaders/productList": loaders_productList,
    "wake/loaders/productListingPage": loaders_productListingPage,
    "wake/loaders/proxy": loaders_proxy,
    "wake/loaders/recommendations": loaders_recommendations,
    "wake/loaders/shop": loaders_shop,
    "wake/loaders/suggestion": loaders_suggestion,
    "wake/loaders/user": loaders_user,
    "wake/loaders/wishlist": loaders_wishlist,
  },
  actions: {
    "wake/actions/cart/addCoupon": actions_cart_addCoupon,
    "wake/actions/cart/addItem": actions_cart_addItem,
    "wake/actions/cart/addItems": actions_cart_addItems,
    "wake/actions/cart/addKit": actions_cart_addKit,
    "wake/actions/cart/partnerAssociate": actions_cart_partnerAssociate,
    "wake/actions/cart/partnerDisassociate": actions_cart_partnerDisassociate,
    "wake/actions/cart/removeCoupon": actions_cart_removeCoupon,
    "wake/actions/cart/removeKit": actions_cart_removeKit,
    "wake/actions/cart/updateItemQuantity": actions_cart_updateItemQuantity,
    "wake/actions/newsletter/register": actions_newsletter_register,
    "wake/actions/notifyme": actions_notifyme,
    "wake/actions/review/create": actions_review_create,
    "wake/actions/shippingSimulation": actions_shippingSimulation,
    "wake/actions/submmitForm": actions_submmitForm,
    "wake/actions/wishlist/addProduct": actions_wishlist_addProduct,
    "wake/actions/wishlist/removeProduct": actions_wishlist_removeProduct,
  },
  sections: {},
} as const;

export type Manifest = typeof manifest;
export default manifest;
