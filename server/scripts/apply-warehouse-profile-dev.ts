import 'dotenv/config';
import {PrismaClient} from '@prisma/client';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const db=new PrismaClient();
async function main(){const [{name}]=await db.$queryRawUnsafe<Array<{name:string}>>('select current_database() as name');if(name!=='panda_hub_dev')throw new Error('Only panda_hub_dev is allowed');const sql=readFileSync('prisma/migrations/20261006150000_warehouse_profile/migration.sql','utf8');await db.$executeRawUnsafe(sql);const checksum=createHash('sha256').update(sql).digest('hex');await db.$executeRaw`INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,logs,started_at,applied_steps_count) SELECT gen_random_uuid()::text,${checksum},now(),'20261006150000_warehouse_profile',NULL,now(),1 WHERE NOT EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name='20261006150000_warehouse_profile' AND rolled_back_at IS NULL)`;console.log('PASS: warehouse profile applied to '+name);}
main().finally(()=>db.$disconnect()).catch(e=>{console.error(e);process.exitCode=1;});
