let prv_native_id = 'XXX_XXX_XXX';

// Video duration
let duration = document.querySelector('.ytp-time-duration').innerText;
let durationParts = duration.split(':').map(Number).reverse();
let durationInSeconds = durationParts.reduce((total, part, index) => total + part * Math.pow(60, index), 0);

// Sponsor blocks
let sponsorBlocks = document.querySelectorAll('[sponsorblock-category="sponsor"]');
let intervals = [];

sponsorBlocks.forEach((block) => {
    let style = block.getAttribute('style');

    let leftMatch = style.match(/left:\s*(\d+(\.\d+)?)/);
    let rightMatch = style.match(/right:\s*(\d+(\.\d+)?)/);

    let leftValue = parseFloat(leftMatch[1]);
    let rightValue = parseFloat(rightMatch[1]);

    let start = durationInSeconds * leftValue / 100;
    let end = durationInSeconds * (100 - rightValue) / 100;

    intervals.push({start,end});
});

console.log(intervals);