import dotenv from 'dotenv';import {execFileSync} from 'node:child_process';import fs from 'node:fs';dotenv.config({path:'.env.local',override:true});
const u=new URL(process.env.DATABASE_URL!);if(u.hostname!=='localhost'||u.pathname!=='/panda_hub_dev')throw Error('WRONG_TARGET');
const migration='prisma/migrations/20261007330000_development_business_ci_workflow_states/migration.sql';
const result=execFileSync('/opt/homebrew/bin/psql',['-X','-v','ON_ERROR_STOP=1'],{input:fs.readFileSync(migration),encoding:'utf8',env:{...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGDATABASE:u.pathname.slice(1),PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password)}});console.log(result);
