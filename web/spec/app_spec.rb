require_relative 'spec_helper'
require_relative '../app'
require 'json'

RSpec.describe 'App' do
  def app
    Sinatra::Application
  end

  it 'serves index page' do
    get '/'
    expect(last_response).to be_ok
    expect(last_response.body).to include('<!doctype html>')
  end

  it 'returns nodes json' do
    get '/api/nodes'
    expect(last_response).to be_ok
    data = JSON.parse(last_response.body)
    expect(data.first['node_id']).to eq('node1')
  end
end
