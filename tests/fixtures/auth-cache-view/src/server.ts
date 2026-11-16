import type{ServerPluginContext}from'@aork/sdk/server';
export function activate(context:ServerPluginContext){let reads=0;context.query('fixture.cache',{access:'authenticated',execute:()=>++reads});context.query('fixture.stream',{access:'authenticated',execute:()=>true});}
