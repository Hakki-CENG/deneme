const {norm}=require('./n.js');const cs=[[' a ','a'],['B','b'],['  Cc ','cc']];for(const [i,o] of cs){if(norm(i)!==o){console.error('FAIL',i);process.exit(1)}}console.log('PASS');
