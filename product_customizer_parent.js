// =========================================================================
// DYNAMIC PRODUCT CUSTOMIZER — Page Code (iframe version)
// Paste this into the Page Code panel of your dynamic Product item page.
//
// This replaces the "native elements" version — instead of building the
// preview with Wix Text/Image elements, all of that lives in a standalone
// HTML/JS app (see the customizer-app folder) hosted elsewhere and
// embedded here via an HTML iframe element.
//
// SETUP REQUIRED:
// 1) Deploy the customizer-app folder somewhere (Netlify, Vercel, GitHub
//    Pages, etc.) and get its URL, e.g. https://your-customizer.netlify.app
// 2) On the dynamic page, add an HTML iframe / Custom Embed element,
//    rename it #customizerFrame, and set its source to that URL.
// 3) Same ProductCustomization collection as before (see the field list
//    below).
// 4) NEW — a "ProductDesigns" collection, one row per design option:
//      - product     (Reference -> Stores/Products) which product this
//                     design belongs to
//      - label       (Text) name shown in the dropdown, e.g. "Classic Cup"
//      - imageUrl    (Text) the photo to show — paste a link from Wix
//                     Media Manager's "Copy image URL", or any image host
//      - sortOrder   (Number, optional) controls dropdown order
//    This is generic across product types — trophies, mugs, plaques,
//    etc. each just get their own rows with `product` pointing at them.
// =========================================================================

import wixData from 'wix-data';
import { cart } from 'wix-stores-frontend';

let currentProduct;
let customConfig;

$w.onReady(async function () {
    currentProduct = await $w('#dynamicDataset').getCurrentItem();

    const result = await wixData.query('ProductCustomization')
        .eq('product', currentProduct._id)
        .find();

    if (result.items.length === 0) {
        // No customizer configured for this product — hide the iframe
        $w('#customizerFrame').collapse();
        return;
    }

    customConfig = result.items[0];
    $w('#customizerFrame').expand();

    // Listen for messages coming FROM the iframe app
    $w('#customizerFrame').onMessage((event) => {
        const { type, payload } = event.data;

        if (type === 'CUSTOMIZER_READY') {
            // The iframe just loaded and is ready for its config
            sendInit();
        }

        if (type === 'ADD_TO_CART') {
            handleAddToCart(payload);
        }
    });
});

// Pulls this product's rows from the ProductDesigns collection — these
// become the options in the "Design" dropdown. Works the same way for
// any product type; just add rows pointing at whichever product needs
// design options.
async function loadBaseDesigns() {
    const result = await wixData.query('ProductDesigns')
        .eq('product', currentProduct._id)
        .ascending('sortOrder')
        .find();

    return result.items.map((item) => ({
        id: item._id,
        label: item.label,
        image: item.imageUrl,
    }));
}

async function sendInit() {
    let sizeMap = {};
    try {
        sizeMap = JSON.parse(customConfig.sizeScaleMap || '{}');
    } catch (e) {
        console.warn('sizeScaleMap is not valid JSON for this product', e);
    }

    const baseDesigns = await loadBaseDesigns();

    $w('#customizerFrame').postMessage({
        type: 'INIT',
        payload: {
            productImage: currentProduct.mainMedia,
            productName: currentProduct.name,
            price: currentProduct.price,
            recipientLabel: customConfig.recipientLabel,
            titleLabel: customConfig.titleLabel,
            // Optional: lets each product call its design picker something
            // different — "Trophy Design", "Mug Style", "Plaque Shape", etc.
            // Defaults to "Design" if left blank on the ProductCustomization row.
            designSelectLabel: customConfig.designSelectLabel,
            maxNameLength: customConfig.maxNameLength,
            maxTitleLength: customConfig.maxTitleLength,
            previewFontSize: customConfig.previewFontSize,
            previewFontColor: customConfig.previewFontColor,
            previewMaxWidth: customConfig.previewMaxWidth,
            requireRecipientName: customConfig.requireRecipientName,
            sizeScaleMap: sizeMap,
            baseDesigns: baseDesigns,
        },
    });
}

async function handleAddToCart(payload) {
    const { recipientName, title, size, baseDesign, recipientPosition, titlePosition, designs } = payload;

    const customTextFields = [];
    // Record which base design the shopper picked, so production/
    // fulfillment knows which photo/shape to use.
    if (baseDesign && baseDesign.label) {
        customTextFields.push({ title: 'Design', value: baseDesign.label });
    }
    if (recipientName) {
        customTextFields.push({ title: customConfig.recipientLabel || 'Recipient Name', value: recipientName });
    }
    if (title) {
        customTextFields.push({ title: customConfig.titleLabel || 'Title', value: title });
    }
    if (size) {
        customTextFields.push({ title: 'Size', value: size });
    }
    // Store exact placement as JSON so production/fulfillment can reproduce
    // where the customer dragged the text and any designs on the plaque.
    if (recipientPosition || titlePosition || (designs && designs.length)) {
        customTextFields.push({
            title: 'Layout Data (internal)',
            value: JSON.stringify({ recipientPosition, titlePosition, designs }),
        });
    }

    try {
        await cart.addProducts([{
            productId: currentProduct._id,
            quantity: 1,
            options: { customTextFields },
        }]);
        $w('#customizerFrame').postMessage({ type: 'ADD_TO_CART_SUCCESS' });
    } catch (err) {
        console.error('Add to cart failed', err);
        $w('#customizerFrame').postMessage({
            type: 'ADD_TO_CART_ERROR',
            payload: { message: err.message },
        });
    }
}