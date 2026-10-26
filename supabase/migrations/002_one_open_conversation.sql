-- One open conversation per customer. Meta can deliver the same webhook twice at the
-- same instant; without this, both copies could open a conversation for a new customer.

-- Clean up any existing duplicates: keep the open conversation that has messages (or the oldest).
delete from conversations v
where v.status <> 'closed'
  and not exists (select 1 from messages m where m.conversation_id = v.id)
  and exists (
    select 1 from conversations o
    where o.customer_id = v.customer_id and o.status <> 'closed' and o.id <> v.id
  );

create unique index if not exists conversations_one_open_per_customer
  on conversations (customer_id) where status <> 'closed';
