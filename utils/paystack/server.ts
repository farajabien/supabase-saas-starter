'use server';

import { createClient } from '@/utils/supabase/server';
import { getURL, getErrorRedirect } from '@/utils/helpers';
import { Tables } from '@/types_db';
import { randomUUID } from 'crypto';

type Price = Tables<'prices'>;

type CheckoutResponse = {
  errorRedirect?: string;
  authorizationUrl?: string;
};

export async function checkoutWithPaystack(
  price: Price,
  redirectPath: string = '/account'
): Promise<CheckoutResponse> {
  try {
    // Get the user from Supabase auth
    const supabase = createClient();
    const {
      error,
      data: { user }
    } = await supabase.auth.getUser();

    if (error || !user) {
      console.error(error);
      throw new Error('Could not get user session.');
    }

    // Create a reference ID for this transaction
    const reference = `sub_${randomUUID()}`;

    // Check if customer exists in our database
    const { data: customerData } = await supabase
      .from('customers')
      .select('paystack_customer_id')
      .eq('id', user.id)
      .single();

    if (!customerData?.paystack_customer_id) {
      // Create customer record if it doesn't exist
      await supabase.from('customers').upsert({
        id: user.id,
        paystack_customer_id: null // Will be updated by webhook after successful payment
      });
    }

    // Initialize transaction with Paystack
    try {
      const response = await fetch(
        'https://api.paystack.co/transaction/initialize',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            email: user.email,
            amount: price.unit_amount, // Amount should be in kobo/cents
            plan: price.id, // This is your plan code in Paystack
            callback_url: getURL(`${redirectPath}?reference=${reference}`),
            metadata: {
              user_id: user.id,
              price_id: price.id,
              reference,
              custom_fields: [
                {
                  display_name: 'User ID',
                  variable_name: 'user_id',
                  value: user.id
                },
                {
                  display_name: 'Price ID',
                  variable_name: 'price_id',
                  value: price.id
                }
              ]
            }
          })
        }
      );

      const data = await response.json();
      console.log('Paystack initialization response:', data);

      if (!data.status) {
        throw new Error(data.message);
      }

      return { authorizationUrl: data.data.authorization_url };
    } catch (err) {
      console.error('Paystack initialization error:', err);
      throw new Error('Unable to initialize payment.');
    }
  } catch (error) {
    console.error('Checkout error:', error);
    if (error instanceof Error) {
      return {
        errorRedirect: getErrorRedirect(
          redirectPath,
          error.message,
          'Please try again later or contact a system administrator.'
        )
      };
    } else {
      return {
        errorRedirect: getErrorRedirect(
          redirectPath,
          'An unknown error occurred.',
          'Please try again later or contact a system administrator.'
        )
      };
    }
  }
}
