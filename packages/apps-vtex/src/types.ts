/**
 * VTEX Checkout / OrderForm types.
 * These mirror the VTEX Checkout API response shapes.
 * Aligned with deco-cx/apps vtex/utils/types.ts
 */

export interface OrderFormItem {
	id: string;
	productId: string;
	productRefId?: string;
	refId?: string;
	ean?: string | null;
	name: string;
	skuName: string;
	imageUrl: string;
	detailUrl: string;
	price: number;
	listPrice: number;
	manualPrice?: number | null;
	quantity: number;
	sellingPrice: number;
	rewardValue?: number;
	isGift?: boolean;
	tax?: number;
	seller: string;
	sellerChain?: string[];
	uniqueId: string;
	parentItemIndex?: number | null;
	parentAssemblyBinding?: string | null;
	availability?: string;
	measurementUnit?: string;
	unitMultiplier?: number;
	productCategoryIds?: string;
	productCategories?: Record<string, string>;
	additionalInfo?: {
		brandName?: string;
		brandId?: string;
		dimension?: Record<string, string> | null;
		offeringInfo?: unknown | null;
		offeringType?: unknown | null;
		offeringTypeId?: unknown | null;
	};
	attachments?: unknown[];
	attachmentOfferings?: Array<{
		name: string;
		required: boolean;
		schema: Record<string, unknown>;
	}>;
	offerings?: Array<{
		type: string;
		id: string;
		name: string;
		price: number;
	}>;
	priceTags?: Array<{
		name: string;
		value: number;
		rawValue: number;
		isPercentual: boolean;
		identifier: string | null;
	}>;
	components?: unknown[];
	bundleItems?: unknown[];
	priceDefinition?: {
		calculatedSellingPrice: number;
		total: number;
		sellingPrices: Array<{
			value: number;
			quantity: number;
		}>;
	};
}

export interface Totalizer {
	id: string;
	name: string;
	value: number;
}

export interface Message {
	code: string;
	text: string;
	status: string;
	fields?: Record<string, string>;
}

export interface MarketingData {
	utmSource?: string;
	utmMedium?: string;
	utmCampaign?: string;
	utmiPage?: string;
	utmiPart?: string;
	utmiCampaign?: string;
	coupon?: string;
	marketingTags?: string[];
}

export interface ClientProfileData {
	email: string;
	firstName?: string | null;
	lastName?: string | null;
	document?: string | null;
	phone?: string | null;
	corporateName?: string | null;
	isCorporate?: boolean;
}

export interface StorePreferencesData {
	countryCode: string;
	saveUserData?: boolean;
	timeZone?: string;
	currencyCode: string;
	currencyLocale?: number;
	currencySymbol: string;
	currencyFormatInfo?: {
		currencyDecimalDigits: number;
		currencyDecimalSeparator: string;
		currencyGroupSeparator: string;
		currencyGroupSize: number;
		startsWithCurrencySymbol: boolean;
	};
}

export interface ClientPreferencesData {
	locale: string;
	optinNewsLetter?: boolean;
}

export interface ShippingData {
	address?: {
		postalCode?: string;
		city?: string;
		state?: string;
		country?: string;
		street?: string;
		number?: string;
		neighborhood?: string;
		complement?: string;
		reference?: string;
	} | null;
	selectedAddresses?: Array<{
		postalCode?: string;
		city?: string;
		state?: string;
		country?: string;
	}>;
	logisticsInfo?: Array<{
		itemIndex: number;
		selectedSla?: string;
		selectedDeliveryChannel?: string;
		slas?: Sla[];
	}>;
}

export interface PaymentData {
	updateStatus?: string;
	installmentOptions?: unknown[];
	paymentSystems?: unknown[];
	payments?: unknown[];
	giftCards?: unknown[];
	availableAccounts?: unknown[];
}

export interface OrderForm {
	orderFormId: string;
	salesChannel: string;
	loggedIn: boolean;
	isCheckedIn: boolean;
	storeId?: unknown | null;
	checkedInPickupPointId?: unknown | null;
	allowManualPrice: boolean;
	canEditData: boolean;
	userProfileId?: unknown | null;
	userType?: unknown | null;
	ignoreProfileData: boolean;
	value: number;
	messages: Message[];
	items: OrderFormItem[];
	selectableGifts?: unknown[];
	totalizers: Totalizer[];
	shippingData: ShippingData | null;
	clientProfileData: ClientProfileData | null;
	paymentData: PaymentData | null;
	marketingData: MarketingData | null;
	sellers?: Array<{ id: string; name: string; logo?: string }>;
	clientPreferencesData?: ClientPreferencesData | null;
	commercialConditionData?: unknown | null;
	storePreferencesData?: StorePreferencesData | null;
	giftRegistryData?: unknown | null;
	openTextField?: unknown | null;
	invoiceData?: unknown | null;
	customData?: unknown | null;
	itemMetadata?: unknown | null;
	hooksData?: unknown | null;
	ratesAndBenefitsData?: {
		rateAndBenefitsIdentifiers?: unknown[];
		teaser?: unknown[];
	} | null;
	subscriptionData?: unknown | null;
	merchantContextData?: unknown | null;
	itemsOrdination?: unknown | null;
}

export interface SimulationOrderForm {
	items: Array<{
		id: string;
		quantity: number;
		seller: string;
		price?: number;
		listPrice?: number;
		offerings?: any[];
		priceTags?: any[];
		availability?: string;
	}>;
	logisticsInfo?: Array<{
		itemIndex: number;
		slas: Sla[];
		selectedSla?: string;
		selectedDeliveryChannel?: string;
	}>;
	paymentData?: {
		installmentOptions?: any[];
	};
}

export interface Sla {
	id: string;
	name: string;
	price: number;
	shippingEstimate: string;
	deliveryChannel?: string;
}

export interface SKU {
	id: string;
	seller: string;
	quantity: number;
}

export interface VtexProduct {
	productId: string;
	productName: string;
	brand: string;
	categoryId: string;
	categories: string[];
	items: any[];
	[key: string]: any;
}
