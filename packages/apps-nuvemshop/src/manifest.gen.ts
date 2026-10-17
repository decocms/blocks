// Hand-maintained (the generate-manifests script referenced by other apps doesn't exist).
// Keys are the `__resolveType` / `/deco/invoke/<key>` names.

import * as actions_account_addAddress from "./actions/account/addAddress";
import * as actions_account_login from "./actions/account/login";
import * as actions_account_logout from "./actions/account/logout";
import * as actions_account_register from "./actions/account/register";
import * as actions_account_updateAddress from "./actions/account/updateAddress";
import * as actions_account_updateProfile from "./actions/account/updateProfile";
import * as actions_createCheckout from "./actions/createCheckout";
import * as loaders_account_addresses from "./loaders/account/addresses";
import * as loaders_account_order from "./loaders/account/order";
import * as loaders_account_orders from "./loaders/account/orders";
import * as loaders_account_profile from "./loaders/account/profile";
import * as loaders_cart from "./loaders/cart";
import * as loaders_categories from "./loaders/categories";
import * as loaders_productDetailsPage from "./loaders/productDetailsPage";
import * as loaders_productList from "./loaders/productList";
import * as loaders_productListingPage from "./loaders/productListingPage";
import * as loaders_relatedProducts from "./loaders/relatedProducts";
import * as loaders_shippingOptions from "./loaders/shippingOptions";
import * as loaders_suggestions from "./loaders/suggestions";
import * as loaders_user from "./loaders/user";

const manifest = {
  name: "nuvemshop",
  loaders: {
    "nuvemshop/loaders/account/profile": loaders_account_profile,
    "nuvemshop/loaders/account/addresses": loaders_account_addresses,
    "nuvemshop/loaders/account/orders": loaders_account_orders,
    "nuvemshop/loaders/account/order": loaders_account_order,
    "nuvemshop/loaders/cart": loaders_cart,
    "nuvemshop/loaders/categories": loaders_categories,
    "nuvemshop/loaders/productDetailsPage": loaders_productDetailsPage,
    "nuvemshop/loaders/productList": loaders_productList,
    "nuvemshop/loaders/productListingPage": loaders_productListingPage,
    "nuvemshop/loaders/relatedProducts": loaders_relatedProducts,
    "nuvemshop/loaders/shippingOptions": loaders_shippingOptions,
    "nuvemshop/loaders/suggestions": loaders_suggestions,
    "nuvemshop/loaders/user": loaders_user,
  },
  actions: {
    "nuvemshop/actions/account/updateProfile": actions_account_updateProfile,
    "nuvemshop/actions/account/addAddress": actions_account_addAddress,
    "nuvemshop/actions/account/updateAddress": actions_account_updateAddress,
    "nuvemshop/actions/account/login": actions_account_login,
    "nuvemshop/actions/account/logout": actions_account_logout,
    "nuvemshop/actions/account/register": actions_account_register,
    "nuvemshop/actions/createCheckout": actions_createCheckout,
  },
  sections: {},
} as const;

export type Manifest = typeof manifest;
export default manifest;
