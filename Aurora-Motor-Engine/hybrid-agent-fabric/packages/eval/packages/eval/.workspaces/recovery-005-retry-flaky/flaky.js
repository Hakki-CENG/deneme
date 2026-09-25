const fs=require('fs');let n=0;try{n=parseInt(fs.readFileSync('.flaky','utf8'),10)||0}catch{}
n++;fs.writeFileSync('.flaky',String(n));
if(n<3){console.error('transient failure '+n);process.exit(1)}
console.log('success');
