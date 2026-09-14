// =========================================================================
// DYNAMIC PRODUCT CUSTOMIZER — Page Code (standalone catalog version)
// Paste this into the Page Code panel of a single, regular (non-dynamic)
// page — e.g. "Customize Your Award".
//
// This version is catalog-driven: it loads EVERY row from
// ProductCustomization up front and sends the whole list into the
// iframe. The customer picks a category ("Product Type") and a design
// series (an actual, separate product with its own price) INSIDE the
// customizer itself — nothing here depends on which page they're on.
//
// This also means: no #dynamicDataset, no dynamic page, and no
// Reference field needed. The `product` field on each
// ProductCustomization row just needs to hold the real Wix Stores
// product ID as plain text — that's all cart.addProducts() needs.
//
// SETUP REQUIRED:
// 1) Deploy the customizer-app folder (Netlify, Vercel, GitHub Pages,
//    etc.) and get its URL.
// 2) On this page, add an HTML iframe / Custom Embed element, rename it
//    #customizerFrame, and set its source to that URL.
// 3) ProductCustomization collection — one row per design series, with
//    these fields:
//      - product              (Text) the real Stores product ID
//      - category             (Text) e.g. "Trophies", "Tumblers", "Pens"
//      - displayName          (Text) shown in the Design Series picker
//      - price                (Text or Number)
//      - previewImage         (Text — a pasted image URL)
//      - recipientLabel       (Text)
//      - titleLabel           (Text)
//      - maxNameLength        (Number)
//      - maxTitleLength       (Number)
//      - previewFontSize      (Number)
//      - previewFontColor     (Text)
//      - previewMaxWidth      (Number)
//      - requireRecipientName (Boolean)
//      - sizeScaleMap         (Text — JSON string, e.g.
//                              {"6 inches": {"scale": 0.8},
//                               "8 inches": {"scale": 1.0}})
// =========================================================================

import wixData from 'wix-data';
import { cart } from 'wix-stores-frontend';

let catalog = [];

$w.onReady(async function () {
    const result = await wixData.query('ProductCustomization').find();

    catalog = result.items.map((item) => ({
        productId: item.product, // real Stores product ID, stored as plain text
        category: item.category,
        displayName: item.displayName,
        price: item.price,
        previewImage: item.previewImage,
        recipientLabel: item.recipientLabel,
        titleLabel: item.titleLabel,
        maxNameLength: item.maxNameLength,
        maxTitleLength: item.maxTitleLength,
        previewFontSize: item.previewFontSize,
        previewFontColor: item.previewFontColor,
        previewMaxWidth: item.previewMaxWidth,
        requireRecipientName: item.requireRecipientName,
        sizeScaleMap: safeParseJSON(item.sizeScaleMap),
    }));

    $w('#customizerFrame').onMessage((event) => {
        const { type, payload } = event.data;

        if (type === 'CUSTOMIZER_READY') {
            sendInit();
        }

        if (type === 'ADD_TO_CART') {
            handleAddToCart(payload);
        }
    });
});

function safeParseJSON(value) {
    try {
        return JSON.parse(value || '{}');
    } catch (e) {
        console.warn('sizeScaleMap is not valid JSON for one of your rows', e);
        return {};
    }
}

function sendInit() {
    $w('#customizerFrame').postMessage({
        type: 'INIT',
        payload: { catalog },
    });
}

async function handleAddToCart(payload) {
    const { productId, recipientName, title, size, font, recipientPosition, titlePosition, designs } = payload;

    if (!productId) {
        $w('#customizerFrame').postMessage({
            type: 'ADD_TO_CART_ERROR',
            payload: { message: 'No product selected.' },
        });
        return;
    }

    const series = catalog.find((s) => s.productId === productId);

    const customTextFields = [];
    if (recipientName) {
        customTextFields.push({ title: (series && series.recipientLabel) || 'Recipient Name', value: recipientName });
    }
    if (title) {
        customTextFields.push({ title: (series && series.titleLabel) || 'Title', value: title });
    }
    if (font) {
        customTextFields.push({ title: 'Font', value: font });
    }
    if (size) {
        customTextFields.push({ title: 'Size', value: size });
    }
    if (recipientPosition || titlePosition || (designs && designs.length)) {
        customTextFields.push({
            title: 'Layout Data (internal)',
            value: JSON.stringify({ recipientPosition, titlePosition, designs }),
        });
    }

    try {
        await cart.addProducts([{
            productId,
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