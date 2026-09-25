function sumEven(xs){let t=0;for(const x of xs){if(x%2===0)t+=x;}return t;}
function sumOdd(xs){let t=0;for(const x of xs){if(x%2!==0)t+=x;}return t;}
module.exports={sumEven,sumOdd};
